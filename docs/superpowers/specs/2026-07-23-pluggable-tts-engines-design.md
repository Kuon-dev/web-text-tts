# Pluggable TTS Engines — Kokoro + Qwen3-TTS

**Date:** 2026-07-23
**Status:** Draft (pending user review)
**Extends:** `2026-07-14-novel-tts-design.md` (v2.13)

## Purpose

Add Qwen3-TTS (Apache-2.0, open weights) as a second TTS engine alongside Kokoro-82M,
selectable at runtime from the UI. Qwen3 brings native Japanese (retiring the romaji
G2P workaround for JP names), 3-second voice cloning, and style instructions
("read this calmly"). Kokoro remains the default and the only viable CPU engine.

Rather than special-casing a second engine, `tts.py` is refactored into a package with
an explicit engine contract, so a third engine is a new file, not a rewrite.

## Requirements

- Same hardware as the base spec: WSL2, Ryzen 7 5700X, RTX 4060 8GB shared with games.
- Engine choice (`kokoro` | `qwen3`) and device mode (`auto` | `gpu` | `cpu`) are
  **independent axes**. Each engine declares which device modes it supports.
- Qwen3 scope this round: **CustomVoice presets** (9 speakers), **style instruction**
  (one global text field, presets only), **voice cloning** (Base variant, 3-second
  reference clip). VoiceDesign and the 1.7B variants are out of scope.
- Qwen3 model size: **0.6B**, and only **one variant resident at a time** (CustomVoice
  for preset voices, Base for cloned voices — swapping voice types reloads, ~seconds,
  absorbed by the lookahead buffer).
- Engine hot-swaps at runtime from the UI; no server restart.
- Qwen3 on CPU is ~0.2–0.3× realtime (unusable): Qwen3 declares CPU unsupported. In
  `auto`, when the GPU is contended it **pauses** (waits for VRAM) instead of falling
  back to CPU; the UI says why. It never silently produces hour-long generations.
- A benchmark script measures Qwen3 0.6B on the actual 4060 (×-realtime, peak VRAM,
  load time, output sample rate) as an early implementation step; its numbers get
  recorded in an addendum here. Third-party numbers suggest ~1–2× realtime; nothing
  published covers this card.

## Architecture

`tts.py` (375 lines, three jobs tangled: Kokoro synthesis, GPU→CPU failover policy,
speed measurement) becomes a package. **Patterns: Template Method** for the synthesis
pipeline (base class owns silence/device/measure steps, engines implement
`_generate`), **Strategy** for device policy (composed, not inherited — Kokoro and
Qwen3 need different thresholds and different failover semantics), **Registry**
for engine discovery, and a thin **manager** for the hot-swap handshake.

```
tts/
  __init__.py   re-exports (server.py and tests keep `from tts import ...`)
  base.py       TTSEngine ABC · Voice · EngineUnavailable · DEVICE_MODES
  device.py     DevicePolicy — the auto/gpu/cpu failover state machine
  registry.py   ENGINES registry + create_engine(); import-guards qwen-tts
  manager.py    EngineManager — current engine, async swap, chunk namespace
  kokoro.py     KokoroEngine (romaji G2P hook moves here)
  qwen.py       Qwen3Engine (variant residency, instruct, cloning)
  voices.py     CloneStore — reference clips + metadata on disk
  worker.py     TTSWorker (contract unchanged; EngineUnavailable handling added)
```

### Engine contract (`base.py`)

```python
class Voice(frozen dataclass):
    id: str        # "af_heart" · "Ryan" · "clone:3fa9c2d81b04"
    name: str      # display name
    group: str     # combobox group: "US female", "Japanese", "Cloned", ...
    language: str  # BCP-47-ish, passed to engines that want it

class EngineUnavailable(RuntimeError):
    """Engine cannot synthesize right now (model loading, GPU contended with
    no CPU fallback). NOT a chunk failure: the worker must not count an
    attempt or mark the chunk failed — it waits and retries."""

class TTSEngine(ABC):
    id: ClassVar[str]                      # "kokoro"
    label: ClassVar[str]                   # "Kokoro-82M"
    supported_modes: ClassVar[tuple]       # ("auto","gpu","cpu") | ("auto","gpu")
    sample_rate: int

    def synthesize(text, voice, urgent=False) -> np.ndarray   # template method:
        # 1. not is_speakable(text) -> 0.4s silence
        # 2. device = policy.pick(urgent)  (raises EngineUnavailable if none)
        # 3. audio = self._generate(text, voice, device)      # abstract
        # 4. policy.measured(...) / policy.failed(...) bookkeeping
    @abstractmethod def _generate(text, voice, device) -> np.ndarray
    @abstractmethod def voices() -> list[Voice]
    @abstractmethod def fingerprint(voice_id) -> str   # cache-key contribution
    def is_speakable(text) -> bool     # default: re.search(r"\w", text) — matches CJK
    def set_mode(mode) / def info() -> dict            # delegate to self.policy
    def unload()                        # drop models, empty CUDA cache
```

Notes:

- **`is_speakable` is engine-owned.** The current check (`[A-Za-z0-9]`, `tts.py:183`)
  silences kanji/kana — every chunk of a Japanese chapter would play as 0.4s of
  silence, defeating Qwen3's headline feature. Base default `\w` (Unicode word char,
  matches CJK) works for Qwen3 and still silences `***` / `◆ ◆ ◆` separators.
  KokoroEngine **overrides** it back to `[A-Za-z0-9]`: its a/b voices can't speak
  Japanese, and silencing it is the existing, correct behavior there.
- **`fingerprint` feeds the cache key** (below). Kokoro returns its pronunciation
  version (currently `"2"`, today hardcoded in `chunker.py:104` — it moves into
  `kokoro.py` where it belongs). Qwen3 returns variant + instruct hash for presets,
  variant + reference-clip SHA-1 for clones.

### DevicePolicy (`device.py`)

The failover machine extracted verbatim from `KokoroEngine` (`_pick_device`,
`_gpu_failed`, `_gpu_measured`, `_gpu_probe_allowed`, VRAM gate, retry backoff),
parameterized:

```python
DevicePolicy(
    allow_cpu: bool,          # Kokoro True, Qwen3 False
    min_gpu_speed: float,     # ×-realtime below which GPU counts as contended
    stall_seconds: float,
    min_free_bytes: int,      # VRAM gate before (re)trying GPU
    release_gpu: Callable,    # engine hook to drop CUDA tensors
    vram_free: Callable,      # injectable for tests (no torch import needed)
)
```

`pick(urgent)` returns `"cuda"` / `"cpu"`, or raises `EngineUnavailable` when
`allow_cpu=False` and the GPU is unhealthy/contended. That exception is the entire
"Qwen3 pauses instead of falling back" behavior — no special cases elsewhere.
Kokoro constructs it with today's constants (`GPU_MIN_SPEED=1.5` etc.); the mid-chunk
stall watchdog stays in `kokoro.py` (it hooks Kokoro's segment stream; Qwen3's
generate is a single call and relies on measured speed instead).

This finally makes the failover state machine unit-testable without torch or a GPU.

### EngineManager (`manager.py`)

Holds the current engine behind one RLock shared with `synthesize` — an engine swap
therefore waits for the in-flight chunk, then proceeds (the "finish current chunk"
handshake, for free). Public surface, used by server and worker:

- `synthesize / sample_rate / voices / info / set_mode` — delegate to current engine.
- `swap(engine_id)` — **synchronous and cheap**: engines lazy-load their weights
  (Kokoro's pipelines already do; Qwen3's variants do too), so construction is
  instant — `swap` builds the new engine, calls `old.unload()`, swaps the
  reference under the lock. The *weights* load inside the first `_generate`,
  which blocks only the worker thread; `/api/audio` 503s and the client retries
  — existing behavior. Engines report `cold: true` in `info()` until weights are
  resident, so the UI can say "loading model".
- `chunk_namespace(voice_id) -> str` — `f"{engine.id}\x00{engine.fingerprint(voice_id)}\x00{voice_id}"`,
  computable **without** the model loaded (fingerprints are metadata), so the doc can
  re-chunk immediately on swap while weights stream in.

### Cache keys

`chunker.chunk_id(voice, text)` becomes `chunk_id(namespace, text)` — still
`sha1(namespace + "\x00" + text)`, still pure. The server composes the namespace via
the manager. Consequences, all intended: changing engine, instruct text, or a clone's
reference clip changes every cid → stale audio stops being served and LRU eviction
collects the orphans (the existing `PRONUNCIATION_V` bump mechanism, generalized).
Kokoro cids change once (namespace grew a prefix): one-time full regeneration,
same cost as the v2.13 pronunciation bump.

### Qwen3Engine (`qwen.py`)

- `pip install qwen-tts`; models `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` and
  `...-0.6B-Base` (~1.8GB BF16 each), downloaded on first use.
- Lazy **variant residency**: synthesizing a preset voice loads CustomVoice,
  a cloned voice loads Base; loading either unloads the other + empties the CUDA
  cache. Only ever one resident — the 8GB card is shared with games.
- Presets: the 9 documented speakers, `group` by language ("English male",
  "Japanese female", …). Clones from `CloneStore`, group "Cloned".
- `instruct` (global style instruction, from state) is passed to
  `generate_custom_voice` for presets only; hashed into their fingerprint.
- Output sample rate: expected 24kHz ("12Hz" in the model name is token rate, not
  audio) — **verified by the benchmark**, and `sample_rate` is set from it.
  The `language` parameter handling (fixed per-voice vs. auto-detect) is also
  pinned down at benchmark time.
- If `qwen-tts` isn't installed or fails to import, the registry lists the engine
  as `available: false` with a reason; nothing else breaks. This also contains the
  risk that qwen-tts and kokoro pin conflicting torch versions — if they do,
  qwen goes into `requirements-qwen.txt` (documented, optional) instead of
  `requirements.txt`.

### CloneStore (`voices.py`)

`voices/<id>/ref.wav` + `meta.json` (`{name, language, ref_sha1, created}`) under the
data dir, beside `cache/` and `images/` (gitignored like them);
id = `"clone:" + ref_sha1[:12]`. Validates clips with soundfile (3–30s, decodable),
like `images.py` validates uploads. Presets are never deletable; clones are.

### Worker (`worker.py`)

`TTSWorker` moves, contract unchanged, three edits:

- Catches `EngineUnavailable`: no attempt counted, no `failed` mark, wait ~5s and
  re-pick. (Plain exceptions keep today's retry-then-fail behavior.)
- `SAMPLE_RATE` constant → `manager.sample_rate` (WAV write, duration math at
  `tts.py:291`, speed measurement, `EST_BYTES_PER_CHAR`).
- Constructor takes the manager (duck-typed like today's engine — `FakeEngine`
  tests keep working with a `sample_rate` attribute added).

Backfill gating needs no change: at Qwen3's ~1–2× realtime, measured speed sits
below `FILL_MIN_SPEED=4.0`, so backfill self-limits to probe cadence — which is the
correct behavior for a barely-keeping-up engine.

## State migration (`state.json`)

| old | new |
|---|---|
| `engine: "auto"` (device mode!) | `device_mode: "auto"` · `engine: "kokoro"` |
| `voice: "af_heart"` | `voices: {kokoro: "af_heart"}` (per-engine memory) |
| — | `instruct: ""` |

Migration lives in one helper used by both `AppState` and the pre-CUDA peek in
`main()` (`server.py:301-306`, which must now read both fields). Old fields are
rewritten on first save; validation is per-engine (a voice must exist in its
engine's catalog; a device mode must be in `supported_modes`, else drop to the
engine's default). Per-engine voice memory means A/B-ing engines doesn't forget
your Kokoro voice.

## API changes

- `GET /api/engines` *(new, fetched once)* — `{engines: [{id, label, available,
  reason?, supported_modes}], current}`.
- `GET /api/voices` — was `{voices: [str], current}`; becomes
  `{voices: [{id, name, group, language}], current}` for the **active** engine.
  The frontend's regex voice parser (`api.ts:83-101`, assumes `af_`/`bm_`… ids)
  is deleted; the combobox groups by the server-provided `group`.
- `POST /api/state` — `engine` now takes an engine id (swap trigger: persists,
  kicks `manager.swap`, resets voice to that engine's remembered/default voice,
  re-chunks — reusing the existing voice-change path at `server.py:202-207`);
  new `device_mode` (validated against `supported_modes`); new `instruct`
  (re-chunks when changed, since preset cids depend on it).
- `POST /api/voices/clone?name=…&language=…` *(new)* — raw audio body, like
  `/api/image`; returns the new `Voice`. `DELETE /api/voices/{id}` — clones only.
- `GET /api/status` — `engine` object gains `engine: id`, `label`, `cold`
  (weights not yet resident), and `blocked: str | null` (the worker's last
  `EngineUnavailable` reason, cleared on success), so the UI can say *why*
  nothing is generating.

## Frontend changes

- `EngineModePicker` → engine section (Kokoro / Qwen3 cards with availability +
  "loading model…" state) above the existing device-mode buttons (filtered to
  `supported_modes`, current descriptions kept). `EngineMode` type renamed to
  match `device_mode`.
- `VoiceCombobox` groups from server metadata; clone entries get an upload flow in
  settings (file input → POST, toast on validation error) and a delete affordance.
- Settings gains the instruct text field, shown when Qwen3 is active.
- Status strip: "loading model…" and "paused — GPU busy (Qwen3 has no CPU mode)"
  states from `/api/status`.

## Error handling

- Engine swap: `POST /api/state` returns immediately (construction is lazy);
  UI shows "loading model" while `cold`; audio requests 503 → client's
  existing retry loop.
- Qwen3 + GPU contended: worker idles on `EngineUnavailable` (no failed marks),
  status shows `blocked`, UI suggests switching to Kokoro. Pinned `gpu` mode
  bypasses the gate exactly as it does today (user's explicit choice).
- Clone upload rejected (too short/long, undecodable) → 400 with reason → toast.
- `qwen-tts` missing → engine card disabled with reason; server otherwise normal.
- Cold-start model download (~1.8GB/variant) happens inside the first
  `EngineUnavailable`-guarded load; the UI just sees a long "loading model".

## Testing

- `test_device_policy.py` *(new)* — the failover machine, isolated: injected
  `vram_free`, `allow_cpu` False→`EngineUnavailable`, backoff, recovery,
  measured-speed transitions. This state machine has never been directly
  testable before.
- `test_manager.py` *(new)* — swap handshake (in-flight chunk finishes), loading
  state raises `EngineUnavailable`, namespace changes with engine/instruct/clone.
- `test_voices.py` *(new)* — CloneStore CRUD + validation; preset deletion 403/404.
- `test_worker.py` — add: `EngineUnavailable` doesn't count attempts or mark failed;
  duration math follows a non-24k `sample_rate` fake.
- `test_server.py` — state migration (old `engine:"auto"` file), per-engine voice
  validation, new endpoints, engine-swap-resets-voice, instruct re-chunk.
- `test_chunker.py` — `chunk_id(namespace, text)` signature change.
- `tests/test_qwen_smoke.py` *(new, `-m slow`)* — one real preset chunk + one clone
  chunk, asserts non-trivial WAV and reports measured sample rate.
- `scripts/bench_qwen.py` *(new)* — load time, ×-realtime over 3 runs of a real
  ~400-char paragraph, `torch.cuda.max_memory_allocated`, output sample rate.
  Run before the engine work lands; numbers recorded in an addendum here.

## Dependencies

- `qwen-tts` (+ its transformers pin) in `requirements.txt`, moved to an optional
  `requirements-qwen.txt` only if it conflicts with kokoro's torch pin.
- No new apt deps. No frontend deps.

## Out of scope (deliberately)

- VoiceDesign variant and 1.7B models.
- Cross-engine auto-failover (Qwen3-on-GPU → Kokoro-on-CPU mid-chapter): the
  narrator's voice changing mid-chapter is worse than a pause; revisit only if
  the pause UX proves annoying in practice.
- Streaming synthesis (Qwen3 supports it; the chunk-WAV architecture doesn't need it).
- Per-voice or per-paragraph instruct.

## Addendum: benchmark status (2026-07-23)

Task 1's measurements are DEFERRED — no CUDA box was reachable from this
session. `scripts/bench_qwen.py` is committed and ready. pip dependency
resolution for `qwen-tts` alongside `kokoro` succeeded with no version conflicts
(qwen-tts 0.1.1 and kokoro 0.7.16 coexist; qwen-tts requires torch via torchaudio
and transformers==4.57.3, kokoro requires torch with no version pin). Blockers
this leaves open (reconciled by Task 12 on the 4060 box): measured sample rate
(engine assumes 24000), x-realtime, peak VRAM, load time, and the exact
voice-clone call signature (engine implements the documented `generate_voice_clone`).
