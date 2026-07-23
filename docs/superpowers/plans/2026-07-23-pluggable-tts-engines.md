# Pluggable TTS Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single hardcoded Kokoro engine into a pluggable engine architecture and add Qwen3-TTS 0.6B (presets + style instruction + voice cloning) as a runtime-selectable second engine.

**Architecture:** `tts.py` becomes the `tts/` package: a `TTSEngine` ABC (Template Method: base owns silence/device/measure, engines implement `_generate`), a composed `DevicePolicy` strategy (the extracted GPU→CPU failover machine), a registry + `EngineManager` (synchronous swap under a lock shared with `synthesize`), and the moved `TTSWorker`. Cache keys gain an engine namespace so engine/instruct/clone changes invalidate cleanly. Spec: `docs/superpowers/specs/2026-07-23-pluggable-tts-engines-design.md`.

**Tech Stack:** Python 3.12, FastAPI, kokoro, qwen-tts (torch), soundfile, pytest; React 19 + Vite + shadcn/ui frontend.

## Global Constraints

- All paths relative to the repo root (the directory containing `server.py`). Work in the existing git repo — no worktree.
- Use `.venv/bin/python` / `.venv/bin/pytest`. The fast suite (`.venv/bin/pytest -m "not slow"`) must pass after every task, **including on a machine with no GPU and no `qwen-tts` installed** — never import `torch`, `kokoro`, or `qwen_tts` at module top level in `tts/` (import inside functions, as `tts.py` does today).
- Tasks 1 and 12 need the RTX 4060 (WSL2) box. Everything else runs anywhere.
- Audio cache stays `cache/{cid}.wav`; cid = `sha1(namespace + "\x00" + text)`; namespace = `engine_id \x00 fingerprint \x00 voice_id`.
- Server binds `127.0.0.1:8765`. Default engine `kokoro`, default device mode `auto`, default voices: kokoro `af_heart`, qwen3 `Ryan`.
- Git commits: author `kuon <aaronlyn88@gmail.com>`. NEVER add a Co-Authored-By trailer (repo convention, see the 2026-07-14 plan).
- Runtime dirs `cache/`, `images/`, `voices/`, `wallpaper`, `novel.txt`, `state.json` are gitignored.
- qwen-tts model downloads (~1.8 GB per variant) are slow — never abort a long download.

---

### Task 1: Qwen3 benchmark script + dependency decision (4060 box)

**Files:**
- Create: `scripts/bench_qwen.py`
- Modify: `requirements.txt` (or create `requirements-qwen.txt` — see Step 3)
- Modify: `.gitignore` (add `voices/`)

**Interfaces:**
- Produces (recorded in a spec addendum, consumed by Tasks 9–10): measured output `sample_rate`, ×-realtime on GPU, peak VRAM, model load seconds, the exact voice-clone call signature in the installed `qwen-tts` version, and whether `qwen-tts` coexists with `kokoro` in one venv.

- [ ] **Step 1: Write the benchmark script**

```python
"""Measure Qwen3-TTS 0.6B on this machine: load time, x-realtime, peak VRAM, sample rate.

Usage (4060 box):  .venv/bin/python scripts/bench_qwen.py [--variant CustomVoice|Base]
Records the numbers that gate the Qwen3 engine design (spec 2026-07-23).
"""
import argparse
import time

PARA = (
    "The gates of the old capital rose out of the morning mist, and for a moment "
    "nobody in the caravan spoke. Kaede tightened her grip on the reins. Whatever "
    "waited past those walls - the guild examiners, the debt collectors, the rumor "
    "of a dungeon breathing under the palace - it could not be worse than another "
    "winter on the road. 'We move at first light,' the captain said."
)  # ~400 chars, one real chapter-sized chunk


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="CustomVoice", choices=["CustomVoice", "Base"])
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    import torch
    from qwen_tts import Qwen3TTSModel

    name = f"Qwen/Qwen3-TTS-12Hz-0.6B-{args.variant}"
    t0 = time.monotonic()
    model = Qwen3TTSModel.from_pretrained(name, device_map="cuda:0", dtype=torch.bfloat16)
    print(f"load: {time.monotonic() - t0:.1f}s  ({name})")
    print("voice-clone API:", [m for m in dir(model) if "clone" in m.lower() or "voice" in m.lower()])

    torch.cuda.reset_peak_memory_stats()
    for i in range(args.runs):
        t0 = time.monotonic()
        wavs, sr = model.generate_custom_voice(text=PARA, language="English", speaker="Ryan")
        wall = time.monotonic() - t0
        dur = len(wavs[0]) / sr
        print(f"run {i}: {dur:.1f}s audio in {wall:.1f}s = {dur / wall:.2f}x realtime (sr={sr})")
    print(f"peak VRAM: {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Install and run on the 4060 box**

```bash
.venv/bin/pip install -U qwen-tts   # watch for a torch/transformers conflict with kokoro
.venv/bin/python scripts/bench_qwen.py
.venv/bin/pytest -m slow            # kokoro smoke must STILL pass in the same venv
```
Expected: three `x realtime` lines, a peak-VRAM line, the printed clone-API method names, and a green kokoro smoke test.

*If this box is not available right now:* commit the script anyway, run `pip install qwen-tts` in a scratch venv to at least verify dependency resolution, and leave Step 2/3's measurements as an explicit blocker on Tasks 9 and 12 — do not silently skip.

- [ ] **Step 3: Record the results**

- If pip resolved cleanly beside kokoro: add `qwen-tts` to `requirements.txt`. If it conflicted: create `requirements-qwen.txt` with `qwen-tts` and note the conflict in the addendum.
- Append an addendum to `docs/superpowers/specs/2026-07-23-pluggable-tts-engines-design.md`: measured sample rate, ×-realtime, peak VRAM, load time, the exact clone-call signature, and the `language` parameter behavior (fixed vs auto).
- Add `voices/` to `.gitignore`.

- [ ] **Step 4: Commit**

```bash
git add scripts/bench_qwen.py requirements*.txt .gitignore docs/superpowers/specs/
git commit -m "feat: qwen3-tts benchmark script + measured 4060 numbers"
```

---

### Task 2: Convert `tts.py` into the `tts/` package (pure move)

**Files:**
- Create: `tts/__init__.py`, `tts/worker.py`, `tts/kokoro.py`
- Delete: `tts.py`

**Interfaces:**
- Produces: `tts/kokoro.py` holds `KokoroEngine`, `VOICES`, `SAMPLE_RATE`, `ENGINE_MODES`, and all the GPU constants; `tts/worker.py` holds `TTSWorker` + worker constants (imports `SAMPLE_RATE` from `.kokoro` for now). `from tts import ENGINE_MODES, VOICES, KokoroEngine, TTSWorker, SAMPLE_RATE` keeps working — `server.py` and all tests are untouched in this task.

- [ ] **Step 1: Move the file and split it**

```bash
mkdir tts && git mv tts.py tts/worker.py
```

Cut `KokoroEngine`, `VOICES`, `SAMPLE_RATE`, `ENGINE_MODES`, and the GPU_*/engine constants (lines 16–66 and the class at 69–215 of the old file) from `tts/worker.py` into a new `tts/kokoro.py` (same imports: `logging`, `re`, `time`, `numpy`, plus `from romaji import RomajiFallback` stays inside `_pipeline`). At the top of `tts/worker.py` add:

```python
from .kokoro import SAMPLE_RATE
```

`tts/__init__.py`:

```python
"""TTS engines + generate-ahead worker. Import surface for server.py and tests."""
from .kokoro import ENGINE_MODES, SAMPLE_RATE, VOICES, KokoroEngine
from .worker import TTSWorker
```

- [ ] **Step 2: Run the full fast suite**

Run: `.venv/bin/pytest -m "not slow"`
Expected: PASS, identical count to before the move (the suite currently collects from `tests/test_chunker.py`, `test_images.py`, `test_romaji.py`, `test_server.py`, `test_wallpaper.py`, `test_worker.py`).

- [ ] **Step 3: Commit**

```bash
git add -A tts.py tts/
git commit -m "refactor: split tts.py into tts/ package (kokoro + worker), no behavior change"
```

---

### Task 3: `tts/base.py` — Voice, EngineUnavailable, TTSEngine ABC

**Files:**
- Create: `tts/base.py`
- Test: `tests/test_base.py`

**Interfaces:**
- Produces (used by every later task):
  - `Voice` — frozen dataclass `id/name/group/language: str`
  - `EngineUnavailable(RuntimeError)`
  - `DEVICE_MODES = ("auto", "gpu", "cpu")`
  - `TTSEngine` ABC: ClassVars `id`, `label`, `supported_modes`, `default_voice`; attr `sample_rate: int`; `synthesize(text, voice, urgent=False) -> np.ndarray` (template method); abstract `_generate(text, voice, device)`, `voices() -> list[Voice]`, `fingerprint(voice_id) -> str`; overridable `is_speakable(text) -> bool`, `set_instruct(text)`, `unload()`; `set_mode(mode)` / `info() -> dict` delegating to `self.policy`.
- Consumes: a `policy` object with `pick(urgent) -> "cuda"|"cpu"`, `measured(speed)`, `failed(reason)`, `set_mode(mode)`, `info() -> dict` (real one arrives in Task 4; tests fake it).

- [ ] **Step 1: Write the failing tests**

`tests/test_base.py`:

```python
import numpy as np
import pytest

from tts.base import DEVICE_MODES, EngineUnavailable, TTSEngine, Voice


class FakePolicy:
    def __init__(self, device="cpu"):
        self.device = device
        self.measured_speeds, self.failures, self.modes = [], [], []

    def pick(self, urgent=False):
        return self.device

    def measured(self, speed):
        self.measured_speeds.append(speed)

    def failed(self, reason):
        self.failures.append(reason)

    def set_mode(self, mode):
        self.modes.append(mode)

    def info(self):
        return {"mode": "auto", "active": self.device, "gpu_available": False}


class ToyEngine(TTSEngine):
    id = "toy"
    label = "Toy"
    default_voice = "v1"
    sample_rate = 24000

    def __init__(self, policy, fail=False, seconds=1.0):
        super().__init__(policy)
        self.fail = fail
        self.seconds = seconds

    def _generate(self, text, voice, device):
        if self.fail:
            raise RuntimeError("boom")
        return np.zeros(int(self.seconds * self.sample_rate), dtype=np.float32)

    def voices(self):
        return [Voice(id="v1", name="V1", group="Toys", language="en")]

    def fingerprint(self, voice_id):
        return "fp1"


def test_unspeakable_returns_silence_without_touching_policy():
    policy = FakePolicy()
    audio = ToyEngine(policy).synthesize("* * *", "v1")
    assert len(audio) == int(0.4 * 24000)
    assert policy.measured_speeds == [] and policy.failures == []


def test_default_is_speakable_accepts_cjk():
    engine = ToyEngine(FakePolicy())
    assert engine.is_speakable("彼女は頷いた。")     # kanji/kana are \w
    assert engine.is_speakable("Hello.")
    assert not engine.is_speakable("◆ ◆ ◆")


def test_gpu_failure_reported_to_policy_and_reraised():
    policy = FakePolicy(device="cuda")
    with pytest.raises(RuntimeError):
        ToyEngine(policy, fail=True).synthesize("Hello there.", "v1")
    assert policy.failures == ["boom"]


def test_cpu_failure_not_reported_as_gpu_failure():
    policy = FakePolicy(device="cpu")
    with pytest.raises(RuntimeError):
        ToyEngine(policy, fail=True).synthesize("Hello there.", "v1")
    assert policy.failures == []


def test_engine_unavailable_passes_through_unwrapped():
    class GatedPolicy(FakePolicy):
        def pick(self, urgent=False):
            raise EngineUnavailable("gpu contended")

    with pytest.raises(EngineUnavailable):
        ToyEngine(GatedPolicy()).synthesize("Hello there.", "v1")


def test_info_merges_engine_identity_with_policy():
    info = ToyEngine(FakePolicy()).info()
    assert info["engine"] == "toy" and info["label"] == "Toy"
    assert info["mode"] == "auto" and info["cold"] is False


def test_device_modes_tuple():
    assert DEVICE_MODES == ("auto", "gpu", "cpu")
    assert TTSEngine.supported_modes == DEVICE_MODES
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_base.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts.base'`

- [ ] **Step 3: Implement `tts/base.py`**

```python
"""Engine contract: Voice, EngineUnavailable, the TTSEngine template method."""
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar

import numpy as np

DEVICE_MODES = ("auto", "gpu", "cpu")


@dataclass(frozen=True)
class Voice:
    id: str        # "af_heart" | "Ryan" | "clone:3fa9c2d81b04"
    name: str      # display name
    group: str     # combobox group ("US female", "Japanese", "Cloned", ...)
    language: str  # hint passed to engines that want it


class EngineUnavailable(RuntimeError):
    """Cannot synthesize right now (weights loading, GPU contended with no CPU
    fallback). NOT a chunk failure: the worker waits and retries without
    counting an attempt or marking the chunk failed."""


class TTSEngine(ABC):
    id: ClassVar[str]
    label: ClassVar[str]
    supported_modes: ClassVar[tuple[str, ...]] = DEVICE_MODES
    default_voice: ClassVar[str]
    sample_rate: int = 24000

    def __init__(self, policy):
        self.policy = policy

    def synthesize(self, text: str, voice: str, urgent: bool = False) -> np.ndarray:
        if not self.is_speakable(text):
            # scene separators ("***", "◆ ◆ ◆") are a narrator pause, not input
            return np.zeros(int(0.4 * self.sample_rate), dtype=np.float32)
        device = self.policy.pick(urgent)
        start = time.monotonic()
        try:
            audio = self._generate(text, voice, device)
        except EngineUnavailable:
            raise                      # a gate, not a generation failure
        except Exception as exc:
            if device == "cuda":
                self.policy.failed(str(exc))
            raise
        wall = time.monotonic() - start
        if device == "cuda" and wall >= 1.0 and len(audio) >= 3 * self.sample_rate:
            self.policy.measured((len(audio) / self.sample_rate) / wall)
        return audio

    @abstractmethod
    def _generate(self, text: str, voice: str, device: str) -> np.ndarray: ...

    @abstractmethod
    def voices(self) -> list[Voice]: ...

    @abstractmethod
    def fingerprint(self, voice_id: str) -> str:
        """Cache-key contribution: anything that changes audio for the same
        (voice, text) — pronunciation rules, model variant, instruct, ref clip."""

    def is_speakable(self, text: str) -> bool:
        return re.search(r"\w", text) is not None  # \w matches CJK

    def set_instruct(self, text: str) -> None:
        """Global style instruction; engines that support it override."""

    def set_mode(self, mode: str) -> None:
        self.policy.set_mode(mode)

    def info(self) -> dict:
        return {"engine": self.id, "label": self.label, "cold": False,
                **self.policy.info()}

    def unload(self) -> None:
        """Drop model refs / free VRAM before an engine swap."""
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_base.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add tts/base.py tests/test_base.py
git commit -m "feat: TTSEngine contract (Voice, EngineUnavailable, template synthesize)"
```

---

### Task 4: `tts/device.py` — DevicePolicy (extracted failover machine)

**Files:**
- Create: `tts/device.py`
- Test: `tests/test_device_policy.py`

**Interfaces:**
- Consumes: `EngineUnavailable` from `tts.base`.
- Produces: `DevicePolicy(allow_cpu, min_gpu_speed, min_free_bytes, mode="auto", gpu_available=False, release_gpu=…, vram_free=…, clock=time.monotonic)` with `pick(urgent=False) -> "cuda"|"cpu"` (raises `EngineUnavailable` when nothing can serve), `measured(speed)`, `failed(reason)`, `set_mode(mode)`, `mode` property, `info() -> {"mode","active","gpu_available"}`. Constants `GPU_RETRY_S=600.0`, `GPU_RETRY_MAX_S=3600.0`, `GPU_VRAM_POLL_S=30.0`.

Semantics ported from `KokoroEngine` (old `tts.py:137-180`), two documented deltas: (1) `allow_cpu=False` turns every would-be-CPU answer into `EngineUnavailable`; (2) with `allow_cpu=False`, urgent requests may also probe the GPU after backoff (nothing else can serve them; the old code only probed on background chunks).

- [ ] **Step 1: Write the failing tests**

`tests/test_device_policy.py`:

```python
import pytest

from tts.base import EngineUnavailable
from tts.device import GPU_RETRY_S, GPU_VRAM_POLL_S, DevicePolicy


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(allow_cpu=True, free=8 * 2**30, gpu=True, mode="auto", **kw):
    clock = Clock()
    state = {"free": free, "released": 0}
    policy = DevicePolicy(
        allow_cpu=allow_cpu, min_gpu_speed=1.5, min_free_bytes=1_500_000_000,
        mode=mode, gpu_available=gpu,
        release_gpu=lambda: state.__setitem__("released", state["released"] + 1),
        vram_free=lambda: state["free"], clock=clock, **kw)
    return policy, clock, state


def test_healthy_auto_picks_gpu():
    policy, _, _ = make()
    assert policy.pick() == "cuda"


def test_no_gpu_falls_to_cpu_or_unavailable():
    policy, _, _ = make(gpu=False)
    assert policy.pick() == "cpu"
    policy, _, _ = make(gpu=False, allow_cpu=False)
    with pytest.raises(EngineUnavailable):
        policy.pick()


def test_failed_gpu_backs_off_then_reprobes_when_vram_free():
    policy, clock, _ = make()
    policy.failed("stalled")
    assert policy.pick() == "cpu"                       # failover
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=False) == "cuda"          # probe after backoff


def test_probe_gated_on_free_vram():
    policy, clock, state = make(free=500 * 2**20)       # game holds VRAM
    policy.failed("contended")
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=False) == "cpu"           # gate closed -> no probe
    clock.t += GPU_VRAM_POLL_S + 1
    state["free"] = 8 * 2**30
    assert policy.pick(urgent=False) == "cuda"          # gate open -> probe


def test_slow_measurement_fails_gpu_fast_measurement_recovers():
    policy, clock, _ = make()
    policy.measured(0.4)                                # below min_gpu_speed
    assert policy.pick() == "cpu"
    clock.t += GPU_RETRY_S + 1
    assert policy.pick() == "cuda"
    policy.measured(9.0)
    assert policy.pick() == "cuda"                      # healthy again


def test_backoff_doubles_up_to_max():
    policy, clock, _ = make()
    policy.failed("a")
    first = policy._retry_at - clock.t
    clock.t += first + 1
    policy.pick()
    policy.failed("b")
    assert policy._retry_at - clock.t == pytest.approx(first * 2)


def test_no_cpu_engine_raises_instead_of_falling_back():
    policy, clock, _ = make(allow_cpu=False)
    policy.failed("contended")
    with pytest.raises(EngineUnavailable):
        policy.pick(urgent=True)
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=True) == "cuda"           # urgent may probe: no fallback exists


def test_pinned_modes():
    policy, _, _ = make(mode="gpu")
    policy.failed("ignored")
    assert policy.pick() == "cuda"                      # pinned gpu never fails over
    policy, _, state = make(mode="cpu")
    assert policy.pick() == "cpu"
    policy, _, _ = make(allow_cpu=False)
    with pytest.raises(ValueError):
        policy.set_mode("cpu")                          # unsupported for this engine
    with pytest.raises(ValueError):
        policy.set_mode("warp")


def test_cpu_mode_releases_gpu():
    policy, _, state = make()
    policy.set_mode("cpu")
    assert state["released"] == 1


def test_startup_vram_gate_in_auto():
    policy, _, _ = make(free=500 * 2**20)               # game already holding VRAM
    assert policy.pick() == "cpu"                       # starts unhealthy
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_device_policy.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts.device'`

- [ ] **Step 3: Implement `tts/device.py`**

```python
"""The auto/gpu/cpu failover state machine, extracted from KokoroEngine so
every engine composes it with its own thresholds (Strategy). See the long
rationale comment in tts/kokoro.py for the contention story it encodes."""
import logging
import time

from .base import DEVICE_MODES, EngineUnavailable

log = logging.getLogger("novel-tts")

GPU_RETRY_S = 600.0
GPU_RETRY_MAX_S = 3600.0
GPU_VRAM_POLL_S = 30.0


def _torch_vram_free() -> int:
    import torch
    free, _total = torch.cuda.mem_get_info()
    return free


class DevicePolicy:
    def __init__(self, *, allow_cpu: bool, min_gpu_speed: float, min_free_bytes: int,
                 mode: str = "auto", gpu_available: bool = False,
                 release_gpu=lambda: None, vram_free=_torch_vram_free,
                 clock=time.monotonic):
        self.allow_cpu = allow_cpu
        self.min_gpu_speed = min_gpu_speed
        self.min_free_bytes = min_free_bytes
        self.gpu_available = gpu_available
        self._release_gpu = release_gpu
        self._vram_free = vram_free
        self._clock = clock
        self._mode = "auto"
        self._gpu_ok = True
        self._retry_at = 0.0
        self._retry_wait = GPU_RETRY_S
        self._vram_wait_logged = False
        self.set_mode(mode if mode in self._supported() else "auto")
        if self._mode == "auto" and gpu_available and not self._vram_gate_open():
            self._gpu_ok = False                      # game already holds VRAM
            self._retry_at = self._clock() + GPU_RETRY_S

    def _supported(self):
        return DEVICE_MODES if self.allow_cpu else ("auto", "gpu")

    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str) -> None:
        if mode not in self._supported():
            raise ValueError(f"unsupported device mode: {mode}")
        if mode == self._mode:
            return
        self._mode = mode
        log.info("device mode -> %s", mode)
        if mode == "cpu":
            self._release_gpu()
        else:
            self._gpu_ok = True       # fresh optimism; re-measured on next chunk
            self._retry_wait = GPU_RETRY_S

    def pick(self, urgent: bool = False) -> str:
        if not self.gpu_available or self._mode == "cpu":
            return self._cpu_or_raise("no GPU available")
        if self._mode == "gpu" or self._gpu_ok:
            return "cuda"
        # auto + unhealthy: probe after backoff, gated on free VRAM. With no
        # CPU fallback, urgent chunks may probe too - nothing else serves them.
        if (not urgent or not self.allow_cpu) and self._clock() >= self._retry_at:
            if self._vram_gate_open():
                return "cuda"
            self._retry_at = self._clock() + GPU_VRAM_POLL_S
        return self._cpu_or_raise("GPU contended, no CPU fallback")

    def _cpu_or_raise(self, reason: str) -> str:
        if self.allow_cpu:
            return "cpu"
        raise EngineUnavailable(reason)

    def _vram_gate_open(self) -> bool:
        try:
            free = self._vram_free()
        except Exception:
            return False              # driver unhappy - a probe would fare no better
        if free >= self.min_free_bytes:
            self._vram_wait_logged = False
            return True
        if not self._vram_wait_logged:
            self._vram_wait_logged = True    # one line per contention episode
            log.info("GPU has only %dMB free - waiting for VRAM", free // 2**20)
        return False

    def failed(self, reason: str) -> None:
        if self._mode != "auto":
            return                    # pinned modes: the user chose this
        level = log.warning if self._gpu_ok else log.info
        level("GPU %s - next GPU try in %.0fs", reason, self._retry_wait)
        self._gpu_ok = False
        self._retry_at = self._clock() + self._retry_wait
        self._retry_wait = min(self._retry_wait * 2, GPU_RETRY_MAX_S)
        self._release_gpu()

    def measured(self, speed: float) -> None:
        if self._mode != "auto":
            return
        if speed < self.min_gpu_speed:
            self.failed(f"at {speed:.2f}x realtime (contended)")
        elif not self._gpu_ok:
            log.info("GPU recovered (%.1fx realtime)", speed)
            self._gpu_ok = True
            self._retry_wait = GPU_RETRY_S

    def info(self) -> dict:
        on_gpu = (self.gpu_available and self._mode != "cpu"
                  and (self._mode == "gpu" or self._gpu_ok))
        return {"mode": self._mode, "active": "gpu" if on_gpu else "cpu",
                "gpu_available": self.gpu_available}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_device_policy.py tests/test_base.py -v`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add tts/device.py tests/test_device_policy.py
git commit -m "feat: DevicePolicy - failover state machine extracted and unit-tested"
```

---

### Task 5: Rebase KokoroEngine onto TTSEngine + DevicePolicy

**Files:**
- Modify: `tts/kokoro.py` (rewrite the class; keep the contention rationale comment)
- Modify: `tts/__init__.py`
- Test: `tests/test_kokoro_engine.py` (new; no torch needed)

**Interfaces:**
- Consumes: `TTSEngine`, `Voice` (Task 3); `DevicePolicy` (Task 4).
- Produces: `KokoroEngine(mode="auto")` with `id="kokoro"`, `label="Kokoro-82M"`, `supported_modes=DEVICE_MODES`, `default_voice="af_heart"`, `PRONUNCIATION_V="2"`, `voices()` returning 16 `Voice`s grouped "US female"/"US male"/"UK female"/"UK male", `fingerprint(v)=="2"`, `is_speakable` back to `[A-Za-z0-9]`. `VOICES` (raw id list) stays exported for `server.py` until Task 11.

- [ ] **Step 1: Write the failing tests**

`tests/test_kokoro_engine.py` — construction must not import torch (CI has none), so tests build the class with a `FakePolicy` via `KokoroEngine.__new__` + manual init of the bits under test:

```python
from tts.kokoro import PRONUNCIATION_V, VOICES, KokoroEngine


def make_engine():
    e = KokoroEngine.__new__(KokoroEngine)   # skip __init__: no torch in CI
    e._pipelines = {}
    return e


def test_identity_and_modes():
    assert KokoroEngine.id == "kokoro"
    assert KokoroEngine.supported_modes == ("auto", "gpu", "cpu")
    assert KokoroEngine.default_voice == "af_heart"


def test_voices_metadata():
    voices = make_engine().voices()
    assert [v.id for v in voices] == VOICES
    by_id = {v.id: v for v in voices}
    assert by_id["af_heart"].name == "Heart"
    assert by_id["af_heart"].group == "US female"
    assert by_id["bm_fable"].group == "UK male"
    assert by_id["am_adam"].language == "en-US"
    assert by_id["bf_emma"].language == "en-GB"


def test_fingerprint_is_pronunciation_version():
    assert make_engine().fingerprint("af_heart") == PRONUNCIATION_V == "2"


def test_is_speakable_stays_ascii_only():
    e = make_engine()                        # a/b voices can't speak Japanese:
    assert not e.is_speakable("彼女は頷いた。")  # silencing kanji is correct HERE
    assert not e.is_speakable("* * *")
    assert e.is_speakable("Hello.")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_kokoro_engine.py -v`
Expected: FAIL — `ImportError: cannot import name 'PRONUNCIATION_V'`

- [ ] **Step 3: Rewrite `tts/kokoro.py`**

Keep the module docstring, the big contention comment block, `VOICES`, and the Kokoro-specific constants (`GPU_MIN_SPEED=1.5`, `GPU_STALL_SECONDS=45.0`, `GPU_MIN_FREE_BYTES=1_500_000_000`, `SAMPLE_RATE=24000`). Delete the policy machinery that moved to `device.py` (`_pick_device`, `_gpu_failed`, `_gpu_measured`, `_gpu_probe_allowed`, retry fields) and `ENGINE_MODES` (now `DEVICE_MODES` in base; keep `ENGINE_MODES = DEVICE_MODES` alias for `server.py` until Task 11). The class becomes:

```python
PRONUNCIATION_V = "2"   # moved from chunker.py; bump when pronunciation rules change

_GROUPS = {"af": ("US female", "en-US"), "am": ("US male", "en-US"),
           "bf": ("UK female", "en-GB"), "bm": ("UK male", "en-GB")}


class KokoroEngine(TTSEngine):
    """Lazy per-(language, device) KPipeline wrapper; policy handles failover."""

    id = "kokoro"
    label = "Kokoro-82M"
    default_voice = "af_heart"
    sample_rate = SAMPLE_RATE

    def __init__(self, mode: str = "auto"):
        import torch
        gpu = torch.cuda.is_available()
        super().__init__(DevicePolicy(
            allow_cpu=True, min_gpu_speed=GPU_MIN_SPEED,
            min_free_bytes=GPU_MIN_FREE_BYTES, mode=mode, gpu_available=gpu,
            release_gpu=self._release_gpu,
            # pinned modes never call this: "cpu" must not create a CUDA
            # context, "gpu" ignores the gate (DevicePolicy only gates auto)
        ))
        log.info("Kokoro gpu_available=%s mode=%s", gpu, self.policy.mode)
        self._pipelines = {}

    def voices(self):
        out = []
        for vid in VOICES:
            group, lang = _GROUPS[vid[:2]]
            out.append(Voice(id=vid, name=vid[3:].capitalize(), group=group, language=lang))
        return out

    def fingerprint(self, voice_id):
        return PRONUNCIATION_V

    def is_speakable(self, text):
        # kanji/kana would be espeak-mangled by the a/b voices; keep silencing
        return re.search(r"[A-Za-z0-9]", text) is not None

    def _pipeline(self, voice, device):
        # unchanged from the old tts.py (KPipeline + RomajiFallback hook)
        ...

    def _generate(self, text, voice, device):
        import torch
        start = time.monotonic()
        pieces = []
        for result in self._pipeline(voice, device)(text, voice=voice):
            audio = getattr(result, "audio", None)
            if audio is None and isinstance(result, tuple):
                audio = result[2]
            if audio is not None:
                pieces.append(audio if isinstance(audio, torch.Tensor) else torch.as_tensor(audio))
            if (device == "cuda" and self.policy.mode == "auto"
                    and time.monotonic() - start > GPU_STALL_SECONDS):
                raise RuntimeError(f"stalled mid-chunk (>{GPU_STALL_SECONDS:.0f}s)")
        if not pieces:
            raise RuntimeError(f"Kokoro produced no audio for: {text[:60]!r}")
        return torch.cat(pieces).cpu().numpy().astype(np.float32)

    def _release_gpu(self):
        # unchanged from the old tts.py (drop cuda pipelines, empty_cache)
        ...

    def unload(self):
        self._pipelines = {}
        self._release_gpu()
```

(`...` bodies are the verbatim old code — `git show HEAD~1:tts.py` if needed. The `_gpu_dirty` re-release dance is gone: `DevicePolicy.set_mode("cpu")` calls `release_gpu` immediately and an in-flight CUDA chunk's tensors die with the next `unload`/`empty_cache`; note this simplification in the commit message.)

`tts/__init__.py` adds: `from .base import DEVICE_MODES, EngineUnavailable, TTSEngine, Voice`.

- [ ] **Step 4: Run the fast suite**

Run: `.venv/bin/pytest -m "not slow" -v`
Expected: all pass — `tests/test_worker.py` still passes because `FakeEngine` duck-types `synthesize`; `tests/test_server.py` still passes via the `ENGINE_MODES` alias and untouched `VOICES`.

- [ ] **Step 5: Run the real-model smoke test if on the 4060 box** (else defer to Task 12)

Run: `.venv/bin/pytest -m slow`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tts/ tests/test_kokoro_engine.py
git commit -m "refactor: KokoroEngine on TTSEngine + DevicePolicy composition"
```

---

### Task 6: Worker — namespace cids, engine sample_rate, EngineUnavailable

**Files:**
- Modify: `tts/worker.py`, `chunker.py`
- Test: `tests/test_worker.py`, `tests/test_chunker.py`

**Interfaces:**
- Consumes: `EngineUnavailable` (Task 3).
- Produces (server relies on these in Task 11):
  - `chunker.chunk_id(namespace: str, text: str) -> str` — param renamed, `PRONUNCIATION_V` prefix removed (it lives in the kokoro fingerprint now; namespaces are opaque strings, so all existing call shapes still work).
  - `TTSWorker(cache_dir, engine, unavailable_wait=5.0, ...)` — `engine` may be an engine or the manager (duck-typed); `set_doc(chunks, namespace, position=0)`; `status()` gains `"blocked": str | None`; WAV write + duration math + speed math use `engine.sample_rate`.

- [ ] **Step 1: Add the failing tests**

Append to `tests/test_worker.py` (and add `sample_rate = 24000` as a class attr on the existing `FakeEngine`):

```python
from tts import EngineUnavailable


class GatedEngine(FakeEngine):
    """Unavailable for the first N calls, then works."""

    def __init__(self, gate_calls=3):
        super().__init__()
        self.gate_calls = gate_calls

    def synthesize(self, text, voice, urgent=False):
        self.calls.append(text)
        if len(self.calls) <= self.gate_calls:
            raise EngineUnavailable("gpu contended")
        return np.zeros(1200, dtype=np.float32)


class SlowRateEngine(FakeEngine):
    sample_rate = 48000                      # non-24k: duration math must follow

    def synthesize(self, text, voice, urgent=False):
        return np.zeros(48000, dtype=np.float32)   # exactly 1.0s at 48k


def test_engine_unavailable_does_not_burn_attempts_or_mark_failed(tmp_path):
    engine = GatedEngine(gate_calls=3)
    worker = TTSWorker(tmp_path, engine, unavailable_wait=0.02)
    chunks = make_chunks(1)
    worker.set_doc(chunks, "ns")
    cid = chunk_id("ns", chunks[0].text)
    assert wait_until(lambda: worker.path(cid).exists())   # >MAX_ATTEMPTS calls happened
    assert len(engine.calls) == 4
    assert worker.status()["failed"] == []


def test_blocked_reason_surfaces_and_clears(tmp_path):
    engine = GatedEngine(gate_calls=2)
    worker = TTSWorker(tmp_path, engine, unavailable_wait=0.02)
    worker.set_doc(make_chunks(1), "ns")
    assert wait_until(lambda: worker.status()["blocked"] == "gpu contended")
    assert wait_until(lambda: worker.status()["blocked"] is None)   # cleared on success


def test_duration_math_follows_engine_sample_rate(tmp_path):
    worker = TTSWorker(tmp_path, SlowRateEngine())
    chunks = make_chunks(1)
    worker.set_doc(chunks, "ns")
    cid = chunk_id("ns", chunks[0].text)
    assert wait_until(lambda: cid in worker.status()["durations"])
    assert worker.status()["durations"][cid] == pytest.approx(1.0, abs=0.01)
```

In `tests/test_chunker.py`, rename the voice-flavored test:

```python
def test_chunk_id_depends_on_namespace_and_text():
    assert chunk_id("kokoro\x002\x00af_heart", "Hi.") != chunk_id("kokoro\x002\x00am_adam", "Hi.")
    assert chunk_id("ns", "Hi.") != chunk_id("ns", "Yo.")
    assert chunk_id("ns", "Hi.") == chunk_id("ns", "Hi.")
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `.venv/bin/pytest tests/test_worker.py tests/test_chunker.py -v`
Expected: new tests FAIL (`unavailable_wait` unknown kwarg; no `blocked` key); old ones pass.

- [ ] **Step 3: Implement**

`chunker.py`: delete the `PRONUNCIATION_V` block (moved to `tts/kokoro.py`);

```python
def chunk_id(namespace: str, text: str) -> str:
    return hashlib.sha1((namespace + "\x00" + text).encode("utf-8")).hexdigest()
```

`tts/worker.py`:
- Constructor: add `unavailable_wait: float = 5.0`; keep the param name `engine`; store `self._blocked = None`. Delete `from .kokoro import SAMPLE_RATE`; replace every `SAMPLE_RATE` use with `sr = self._engine.sample_rate` read at use time (WAV write, speed math, and `EST_BYTES_PER_CHAR` becomes `sr * 2 / CHARS_PER_SECOND` computed inside `_pick`).
- `set_doc(self, chunks, namespace, position=0)`: rename `voice` → `namespace` (`self._namespace`), cids = `[chunk_id(namespace, c.text) for c in chunks]`.
- `status()`: durations use `(size - 44) / (sr * 2)`; add `"blocked": self._blocked`.
- `_run()` — the except arm splits:

```python
            except EngineUnavailable as exc:
                with self._cond:
                    self._blocked = str(exc)
                    self._attempts[cid] = self._attempts.get(cid, 1) - 1  # not an attempt
                    self._cond.wait(timeout=self._unavailable_wait)
            except Exception:
                log.exception("chunk %s failed (attempt %d)", cid[:8], self._attempts.get(cid, 0))
                with self._cond:
                    if self._attempts.get(cid, 0) >= MAX_ATTEMPTS:
                        self._failed.add(cid)
```

and the success path sets `self._blocked = None` inside the lock.

- [ ] **Step 4: Run the fast suite**

Run: `.venv/bin/pytest -m "not slow" -v`
Expected: all pass. (`tests/test_server.py` passes untouched: `FakeWorker.set_doc` takes `voice` positionally and the server still passes the voice string as the namespace until Task 11 — namespaces are opaque, so cids are merely differently-salted.)

- [ ] **Step 5: Commit**

```bash
git add chunker.py tts/worker.py tests/test_worker.py tests/test_chunker.py
git commit -m "feat: namespace cache keys, per-engine sample rate, EngineUnavailable wait"
```

---

### Task 7: `tts/registry.py` — engine registry with availability

**Files:**
- Create: `tts/registry.py`
- Test: `tests/test_registry.py`

**Interfaces:**
- Consumes: `KokoroEngine`; `Qwen3Engine` arrives in Task 9 (imported lazily — the registry must work before that file exists via the find_spec guard).
- Produces (manager + server rely on these):
  - `ENGINE_IDS = ("kokoro", "qwen3")`
  - `engine_catalog() -> list[dict]` — `{id, label, available: bool, reason: str|None, supported_modes: list}` for every known engine, importing nothing heavy.
  - `create_engine(engine_id, mode, clone_store=None) -> TTSEngine` — raises `ValueError` on unknown id or unavailable engine.

- [ ] **Step 1: Write the failing tests**

`tests/test_registry.py`:

```python
import pytest

from tts import registry
from tts.registry import ENGINE_IDS, create_engine, engine_catalog


def test_catalog_lists_both_engines_with_modes():
    cat = {e["id"]: e for e in engine_catalog()}
    assert set(cat) == set(ENGINE_IDS) == {"kokoro", "qwen3"}
    assert cat["kokoro"]["available"] is True
    assert cat["kokoro"]["supported_modes"] == ["auto", "gpu", "cpu"]
    assert cat["qwen3"]["supported_modes"] == ["auto", "gpu"]
    assert cat["qwen3"]["label"] == "Qwen3-TTS 0.6B"


def test_qwen_unavailable_without_package(monkeypatch):
    monkeypatch.setattr(registry, "_qwen_installed", lambda: False)
    cat = {e["id"]: e for e in engine_catalog()}
    assert cat["qwen3"]["available"] is False
    assert "qwen-tts" in cat["qwen3"]["reason"]
    with pytest.raises(ValueError, match="qwen-tts"):
        create_engine("qwen3", "auto")


def test_create_engine_rejects_unknown_id():
    with pytest.raises(ValueError, match="unknown engine"):
        create_engine("espeak", "auto")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts.registry'`

- [ ] **Step 3: Implement `tts/registry.py`**

```python
"""Engine discovery. Heavy imports stay inside create_engine so the catalog
(and the fast test suite) never needs torch or qwen-tts installed."""
import importlib.util

ENGINE_IDS = ("kokoro", "qwen3")

_META = {
    "kokoro": {"label": "Kokoro-82M", "supported_modes": ["auto", "gpu", "cpu"]},
    "qwen3": {"label": "Qwen3-TTS 0.6B", "supported_modes": ["auto", "gpu"]},
}


def _qwen_installed() -> bool:
    return importlib.util.find_spec("qwen_tts") is not None


def _availability(engine_id: str) -> str | None:
    """None if usable, else the human-readable reason."""
    if engine_id == "qwen3" and not _qwen_installed():
        return "qwen-tts is not installed (pip install qwen-tts)"
    return None


def engine_catalog() -> list[dict]:
    out = []
    for eid in ENGINE_IDS:
        reason = _availability(eid)
        out.append({"id": eid, **_META[eid],
                    "available": reason is None, "reason": reason})
    return out


def create_engine(engine_id: str, mode: str, clone_store=None):
    if engine_id not in ENGINE_IDS:
        raise ValueError(f"unknown engine: {engine_id}")
    reason = _availability(engine_id)
    if reason is not None:
        raise ValueError(reason)
    if engine_id == "kokoro":
        from .kokoro import KokoroEngine
        return KokoroEngine(mode=mode)
    from .qwen import Qwen3Engine
    return Qwen3Engine(mode=mode, clone_store=clone_store)
```

Labels/modes live in `_META` (plain data) rather than on the classes here so the catalog never triggers an import chain; Task 9's `Qwen3Engine` ClassVars must match `_META` and its test asserts that.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_registry.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add tts/registry.py tests/test_registry.py
git commit -m "feat: engine registry with import-guarded availability"
```

---

### Task 8: `tts/voices.py` — CloneStore

**Files:**
- Create: `tts/voices.py`
- Test: `tests/test_voices.py`

**Interfaces:**
- Consumes: `Voice` (Task 3); `soundfile` for clip validation.
- Produces (qwen engine + server rely on these):
  - `CloneError(ValueError)`
  - `CloneStore(dir_path)`: `add(data: bytes, name: str, language: str = "en") -> Voice` (validates: soundfile-decodable, 3–30 s; id `"clone:" + sha1(data)[:12]`; layout `<dir>/<id_hex>/ref.wav` + `meta.json`); `voices() -> list[Voice]` (group `"Cloned"`); `ref_path(voice_id) -> Path`; `delete(voice_id) -> bool`; `has(voice_id) -> bool`; `fingerprint(voice_id) -> str` (the full ref sha1).

- [ ] **Step 1: Write the failing tests**

`tests/test_voices.py`:

```python
import io

import numpy as np
import pytest
import soundfile as sf

from tts.voices import CloneError, CloneStore


def clip_bytes(seconds=5.0, rate=24000):
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(seconds * rate), dtype=np.float32), rate, format="WAV")
    return buf.getvalue()


def test_add_creates_voice_with_stable_id(tmp_path):
    store = CloneStore(tmp_path)
    data = clip_bytes()
    voice = store.add(data, name="Narrator A")
    assert voice.id.startswith("clone:") and voice.group == "Cloned"
    assert store.add(data, name="Same clip").id == voice.id   # content-addressed
    assert store.ref_path(voice.id).exists()


def test_survives_reload_and_lists(tmp_path):
    CloneStore(tmp_path).add(clip_bytes(), name="Narrator A")
    voices = CloneStore(tmp_path).voices()                    # fresh instance
    assert [v.name for v in voices] == ["Narrator A"]


def test_rejects_bad_clips(tmp_path):
    store = CloneStore(tmp_path)
    with pytest.raises(CloneError, match="decode"):
        store.add(b"not audio at all", name="X")
    with pytest.raises(CloneError, match="3"):
        store.add(clip_bytes(seconds=1.0), name="Too short")
    with pytest.raises(CloneError, match="30"):
        store.add(clip_bytes(seconds=45.0), name="Too long")


def test_delete_and_fingerprint(tmp_path):
    store = CloneStore(tmp_path)
    voice = store.add(clip_bytes(), name="A")
    assert len(store.fingerprint(voice.id)) == 40             # full sha1
    assert store.delete(voice.id) is True
    assert store.voices() == [] and store.delete(voice.id) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_voices.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts.voices'`

- [ ] **Step 3: Implement `tts/voices.py`**

```python
"""Cloned-voice reference clips: voices/<hex>/ref.wav + meta.json (like images.py)."""
import hashlib
import io
import json
import shutil
import time
from pathlib import Path

import soundfile as sf

from .base import Voice

MIN_SECONDS, MAX_SECONDS = 3.0, 30.0


class CloneError(ValueError):
    pass


class CloneStore:
    def __init__(self, dir_path: Path):
        self.dir = Path(dir_path)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _dir(self, voice_id: str) -> Path:
        return self.dir / voice_id.removeprefix("clone:")

    def add(self, data: bytes, name: str, language: str = "en") -> Voice:
        try:
            info = sf.info(io.BytesIO(data))
        except Exception:
            raise CloneError("could not decode audio (wav/flac/ogg supported)")
        seconds = info.frames / info.samplerate
        if seconds < MIN_SECONDS:
            raise CloneError(f"clip too short: need at least {MIN_SECONDS:.0f}s")
        if seconds > MAX_SECONDS:
            raise CloneError(f"clip too long: at most {MAX_SECONDS:.0f}s")
        sha = hashlib.sha1(data).hexdigest()
        vid = f"clone:{sha[:12]}"
        d = self._dir(vid)
        d.mkdir(parents=True, exist_ok=True)
        (d / "ref.wav").write_bytes(data)
        (d / "meta.json").write_text(json.dumps(
            {"name": name, "language": language, "ref_sha1": sha, "created": time.time()}))
        return Voice(id=vid, name=name, group="Cloned", language=language)

    def voices(self) -> list[Voice]:
        out = []
        for meta_path in sorted(self.dir.glob("*/meta.json")):
            meta = json.loads(meta_path.read_text())
            out.append(Voice(id=f"clone:{meta_path.parent.name}", name=meta["name"],
                             group="Cloned", language=meta["language"]))
        return out

    def has(self, voice_id: str) -> bool:
        return voice_id.startswith("clone:") and (self._dir(voice_id) / "meta.json").exists()

    def ref_path(self, voice_id: str) -> Path:
        return self._dir(voice_id) / "ref.wav"

    def fingerprint(self, voice_id: str) -> str:
        meta = json.loads((self._dir(voice_id) / "meta.json").read_text())
        return meta["ref_sha1"]

    def delete(self, voice_id: str) -> bool:
        if not self.has(voice_id):
            return False
        shutil.rmtree(self._dir(voice_id))
        return True
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_voices.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add tts/voices.py tests/test_voices.py
git commit -m "feat: CloneStore for voice-clone reference clips"
```

---

### Task 9: `tts/qwen.py` — Qwen3Engine

**Files:**
- Create: `tts/qwen.py`
- Test: `tests/test_qwen_engine.py` (fake `qwen_tts` module), `tests/test_qwen_smoke.py` (`-m slow`)

**Interfaces:**
- Consumes: `TTSEngine`/`Voice` (Task 3), `DevicePolicy` (Task 4), `CloneStore` (Task 8), Task 1's measured sample rate and clone-call signature.
- Produces: `Qwen3Engine(mode="auto", clone_store=None)` — `id="qwen3"`, `label="Qwen3-TTS 0.6B"` (must equal the registry `_META` label), `supported_modes=("auto","gpu")`, `default_voice="Ryan"`, `PRESETS` (9 speakers), variant residency (`custom` ↔ `base`, one resident), `set_instruct`, `info()` with `cold`.

- [ ] **Step 1: Write the failing tests**

`tests/test_qwen_engine.py` — inject a fake `qwen_tts` before import so no model/package is needed:

```python
import sys
import types

import numpy as np
import pytest


@pytest.fixture()
def fake_qwen(monkeypatch):
    calls = {"loaded": [], "custom": [], "clone": []}

    class FakeModel:
        @classmethod
        def from_pretrained(cls, name, **kw):
            calls["loaded"].append(name)
            return cls()

        def generate_custom_voice(self, *, text, language, speaker, instruct=None):
            calls["custom"].append((text, language, speaker, instruct))
            return [np.zeros(24000, dtype=np.float32)], 24000

        def generate_voice_clone(self, *, text, ref_audio, language):
            calls["clone"].append((text, ref_audio, language))
            return [np.zeros(24000, dtype=np.float32)], 24000

    mod = types.ModuleType("qwen_tts")
    mod.Qwen3TTSModel = FakeModel
    monkeypatch.setitem(sys.modules, "qwen_tts", mod)
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(
        bfloat16="bf16", cuda=types.SimpleNamespace(
            is_available=lambda: True, empty_cache=lambda: None,
            mem_get_info=lambda: (8 * 2**30, 8 * 2**30))))
    return calls


def make_engine(fake_qwen, tmp_path):
    from tts.qwen import Qwen3Engine
    from tts.voices import CloneStore
    return Qwen3Engine(mode="gpu", clone_store=CloneStore(tmp_path))


def test_identity(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    assert (e.id, e.label) == ("qwen3", "Qwen3-TTS 0.6B")
    assert e.supported_modes == ("auto", "gpu")
    assert e.default_voice == "Ryan"
    assert e.info()["cold"] is True                      # nothing loaded yet


def test_preset_synthesis_loads_custom_variant_once(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    e.set_instruct("read it calmly")
    e.synthesize("Hello there, traveler.", "Ryan")
    e.synthesize("Another line.", "Ryan")
    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"]
    assert fake_qwen["custom"][0] == ("Hello there, traveler.", "English", "Ryan", "read it calmly")
    assert e.info()["cold"] is False


def test_clone_synthesis_swaps_to_base_variant(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")
    e.synthesize("Hello.", "Ryan")
    e.synthesize("Cloned line.", voice.id)
    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                                   "Qwen/Qwen3-TTS-12Hz-0.6B-Base"]
    assert fake_qwen["clone"][0][1].endswith("ref.wav")


def test_fingerprints(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    base = e.fingerprint("Ryan")
    e.set_instruct("whisper")
    assert e.fingerprint("Ryan") != base                 # instruct changes preset cids
    voice = e._clones.add(tv.clip_bytes(), name="A")
    fp = e.fingerprint(voice.id)
    assert fp.startswith("base-0.6b") and "whisper" not in fp   # clones ignore instruct


def test_speakable_accepts_japanese(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    assert e.is_speakable("彼女は頷いた。")               # the whole point
    assert not e.is_speakable("◆ ◆ ◆")


def test_voices_are_presets_plus_clones(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    e._clones.add(tv.clip_bytes(), name="Narrator A")
    voices = e.voices()
    ids = [v.id for v in voices]
    assert "Ryan" in ids and "Ono_Anna" in ids and len(ids) == 10
    assert voices[-1].group == "Cloned"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_qwen_engine.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts.qwen'`

- [ ] **Step 3: Implement `tts/qwen.py`**

```python
"""Qwen3-TTS 0.6B: presets (CustomVoice) + clones (Base), one variant resident.

GPU-only: ~0.2-0.3x realtime on CPU is unusable, so DevicePolicy(allow_cpu=False)
pauses (EngineUnavailable) instead of falling back when the GPU is contended.
Thresholds differ from Kokoro's: at ~1-2x realtime on the 4060 (bench 2026-07-23,
see spec addendum), anything under QWEN_MIN_SPEED can't keep up with playback.
"""
import hashlib
import logging

import numpy as np

from .base import TTSEngine, Voice
from .device import DevicePolicy

log = logging.getLogger("novel-tts")

QWEN_MIN_SPEED = 0.8            # below this the reader outruns generation
QWEN_MIN_FREE_BYTES = 2_500_000_000   # 0.6B bf16 weights + KV headroom
_MODELS = {"custom": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
           "base": "Qwen/Qwen3-TTS-12Hz-0.6B-Base"}

# (speaker, group, language-arg) - the 9 documented CustomVoice speakers
PRESETS = [
    ("Ryan", "English male", "English"), ("Aiden", "English male", "English"),
    ("Vivian", "Chinese female", "Chinese"), ("Serena", "Chinese female", "Chinese"),
    ("Uncle_Fu", "Chinese male", "Chinese"), ("Dylan", "Chinese male", "Chinese"),
    ("Eric", "Chinese male", "Chinese"), ("Ono_Anna", "Japanese female", "Japanese"),
    ("Sohee", "Korean female", "Korean"),
]
_PRESET_LANG = {name: lang for name, _, lang in PRESETS}


class Qwen3Engine(TTSEngine):
    id = "qwen3"
    label = "Qwen3-TTS 0.6B"          # must match registry._META
    supported_modes = ("auto", "gpu")
    default_voice = "Ryan"
    sample_rate = 24000               # confirmed by scripts/bench_qwen.py

    def __init__(self, mode: str = "auto", clone_store=None):
        import torch
        super().__init__(DevicePolicy(
            allow_cpu=False, min_gpu_speed=QWEN_MIN_SPEED,
            min_free_bytes=QWEN_MIN_FREE_BYTES, mode=mode,
            gpu_available=torch.cuda.is_available(),
            release_gpu=self._release_gpu))
        self._clones = clone_store
        self._instruct = ""
        self._variant = None          # "custom" | "base"
        self._model = None

    def set_instruct(self, text: str) -> None:
        self._instruct = text or ""

    def voices(self) -> list[Voice]:
        out = [Voice(id=n, name=n.replace("_", " "), group=g, language=l)
               for n, g, l in PRESETS]
        if self._clones is not None:
            out += self._clones.voices()
        return out

    def fingerprint(self, voice_id: str) -> str:
        if voice_id.startswith("clone:"):
            return "base-0.6b\x00" + self._clones.fingerprint(voice_id)
        return "custom-0.6b\x00" + hashlib.sha1(self._instruct.encode()).hexdigest()

    def info(self) -> dict:
        return {**super().info(), "cold": self._model is None}

    def _load(self, variant: str):
        if self._variant == variant:
            return self._model
        import torch
        from qwen_tts import Qwen3TTSModel
        self._release_gpu()           # one variant resident at a time (8GB card)
        log.info("loading %s", _MODELS[variant])
        self._model = Qwen3TTSModel.from_pretrained(
            _MODELS[variant], device_map="cuda:0", dtype=torch.bfloat16)
        self._variant = variant
        return self._model

    def _generate(self, text: str, voice: str, device: str) -> np.ndarray:
        # device is always "cuda" here: policy(allow_cpu=False) never returns cpu
        if voice.startswith("clone:"):
            model = self._load("base")
            wavs, sr = model.generate_voice_clone(          # signature per bench addendum
                text=text, ref_audio=str(self._clones.ref_path(voice)),
                language="Auto")
        else:
            model = self._load("custom")
            wavs, sr = model.generate_custom_voice(
                text=text, language=_PRESET_LANG.get(voice, "Auto"), speaker=voice,
                instruct=self._instruct or None)
        self.sample_rate = sr
        return np.asarray(wavs[0], dtype=np.float32)

    def _release_gpu(self):
        import gc
        self._model = None
        self._variant = None
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def unload(self):
        self._release_gpu()
```

If Task 1's addendum recorded a different clone-call signature (`generate_voice_clone` name/kwargs), use the recorded one — the fake in the test mirrors whatever is real.

`tests/test_qwen_smoke.py`:

```python
"""Real-model smoke: needs GPU + qwen-tts (Task 12 runs this on the 4060 box)."""
import numpy as np
import pytest

pytestmark = pytest.mark.slow


def test_qwen_preset_speaks():
    from tts.qwen import Qwen3Engine
    engine = Qwen3Engine(mode="gpu")
    audio = engine.synthesize("The morning mist rose over the old capital.", "Ryan")
    assert len(audio) > engine.sample_rate  # >1s of real audio
    assert float(np.abs(audio).max()) > 0.01
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_qwen_engine.py -v`
Expected: 6 passed (smoke deselected by the fast marker filter)

- [ ] **Step 5: Commit**

```bash
git add tts/qwen.py tests/test_qwen_engine.py tests/test_qwen_smoke.py
git commit -m "feat: Qwen3Engine - presets, instruct, cloning, variant residency"
```

---

### Task 10: `tts/manager.py` — EngineManager

**Files:**
- Create: `tts/manager.py`
- Modify: `tts/__init__.py`
- Test: `tests/test_manager.py`

**Interfaces:**
- Consumes: `create_engine` (Task 7), `CloneStore` (Task 8), `chunk_id` semantics (Task 6).
- Produces (server + worker rely on these):
  - `EngineManager(data_dir, engine_id="kokoro", mode="auto", factory=create_engine)` — owns `clone_store = CloneStore(data_dir / "voices")`, builds the initial engine via `factory(engine_id, mode, clone_store)`.
  - Delegates under one RLock: `synthesize(text, voice, urgent=False)`, `set_mode`, `set_instruct`, `unload`. Lock-free reads: `engine_id`, `sample_rate` (property → current engine), `voices()`, `info()`, `supported_modes`.
  - `swap(engine_id, mode)` — synchronous: build new via factory, `old.unload()`, swap ref; no-op if already current. Raises `ValueError` from the factory for unknown/unavailable.
  - `chunk_namespace(voice_id) -> str` = `f"{engine.id}\x00{engine.fingerprint(voice_id)}\x00{voice_id}"`.
- `tts/__init__.py` finally exports: `DEVICE_MODES, EngineUnavailable, TTSEngine, Voice, KokoroEngine, TTSWorker, EngineManager, SAMPLE_RATE, VOICES, ENGINE_MODES` (last three still shimmed for `server.py` until Task 11).

- [ ] **Step 1: Write the failing tests**

`tests/test_manager.py`:

```python
import threading
import time

import numpy as np
import pytest

from tts.base import TTSEngine, Voice
from tts.manager import EngineManager


class StubEngine(TTSEngine):
    label = "Stub"
    supported_modes = ("auto", "gpu")
    default_voice = "v"
    sample_rate = 24000

    def __init__(self, eid, block=0.0):
        self.id = eid
        self.block = block
        self.unloaded = False
        self.instructs, self.modes = [], []
        self.policy = None            # not used: we override the plumbing

    def synthesize(self, text, voice, urgent=False):
        time.sleep(self.block)
        return np.zeros(10, dtype=np.float32)

    def _generate(self, text, voice, device):
        raise AssertionError("unused")

    def voices(self):
        return [Voice(id="v", name="V", group="G", language="en")]

    def fingerprint(self, voice_id):
        return f"fp-{self.id}"

    def set_mode(self, mode):
        self.modes.append(mode)

    def set_instruct(self, text):
        self.instructs.append(text)

    def info(self):
        return {"engine": self.id, "label": self.label, "cold": False,
                "mode": "auto", "active": "gpu", "gpu_available": True}

    def unload(self):
        self.unloaded = True


def make_manager(tmp_path, engines):
    return EngineManager(tmp_path, engine_id="a", mode="auto",
                         factory=lambda eid, mode, clone_store: engines[eid](eid))


def test_namespace_folds_engine_fingerprint_voice(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    assert mgr.chunk_namespace("v") == "a\x00fp-a\x00v"


def test_swap_unloads_old_and_changes_namespace(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine, "b": StubEngine})
    old = mgr._engine
    mgr.swap("b", "auto")
    assert old.unloaded and mgr.engine_id == "b"
    assert mgr.chunk_namespace("v") == "b\x00fp-b\x00v"
    mgr.swap("b", "auto")
    assert mgr._engine is not None and mgr.engine_id == "b"   # no-op, no rebuild


def test_swap_waits_for_inflight_synthesize(tmp_path):
    slow = StubEngine("a", block=0.2)
    mgr = make_manager(tmp_path, {"a": lambda eid: slow, "b": StubEngine})
    t = threading.Thread(target=lambda: mgr.synthesize("hi", "v"))
    t.start()
    time.sleep(0.05)                  # thread is inside synthesize, holding the lock
    start = time.monotonic()
    mgr.swap("b", "auto")
    assert time.monotonic() - start > 0.1   # swap had to wait for the chunk
    t.join()


def test_unknown_engine_raises_and_keeps_current(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    with pytest.raises(KeyError):
        mgr.swap("nope", "auto")
    assert mgr.engine_id == "a"


def test_delegation(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    mgr.set_instruct("calm")
    mgr.set_mode("gpu")
    assert mgr._engine.instructs == ["calm"] and mgr._engine.modes == ["gpu"]
    assert mgr.sample_rate == 24000 and mgr.info()["engine"] == "a"
    assert [v.id for v in mgr.voices()] == ["v"]
```

(`make_manager`'s factory raises `KeyError` for unknown ids; the real `create_engine` raises `ValueError` — the manager passes whatever the factory raises through, which is what the last test pins for the injected factory.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest tests/test_manager.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tts.manager'`

- [ ] **Step 3: Implement `tts/manager.py`**

```python
"""Current-engine holder. One RLock shared by synthesize and swap gives the
hot-swap handshake for free: a swap waits for the in-flight chunk, and the
next worker pick sees the new engine. Construction is cheap everywhere -
engines lazy-load weights - so swap is synchronous."""
import threading
from pathlib import Path

from .registry import create_engine
from .voices import CloneStore


class EngineManager:
    def __init__(self, data_dir: Path, engine_id: str = "kokoro",
                 mode: str = "auto", factory=create_engine):
        self.clone_store = CloneStore(Path(data_dir) / "voices")
        self._factory = factory
        self._lock = threading.RLock()
        self._engine = factory(engine_id, mode, self.clone_store)

    @property
    def engine_id(self) -> str:
        return self._engine.id

    @property
    def sample_rate(self) -> int:
        return self._engine.sample_rate

    def synthesize(self, text, voice, urgent=False):
        with self._lock:
            return self._engine.synthesize(text, voice, urgent=urgent)

    def swap(self, engine_id: str, mode: str) -> None:
        with self._lock:
            if engine_id == self._engine.id:
                return
            new = self._factory(engine_id, mode, self.clone_store)  # raises if unavailable
            self._engine.unload()
            self._engine = new

    def chunk_namespace(self, voice_id: str) -> str:
        e = self._engine
        return f"{e.id}\x00{e.fingerprint(voice_id)}\x00{voice_id}"

    def voices(self):
        return self._engine.voices()

    def supported_modes(self):
        return self._engine.supported_modes

    def set_mode(self, mode: str) -> None:
        with self._lock:
            self._engine.set_mode(mode)

    def set_instruct(self, text: str) -> None:
        with self._lock:
            self._engine.set_instruct(text)

    def info(self) -> dict:
        return self._engine.info()

    def unload(self) -> None:
        with self._lock:
            self._engine.unload()
```

Add to `tts/__init__.py`: `from .manager import EngineManager`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/test_manager.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add tts/manager.py tts/__init__.py tests/test_manager.py
git commit -m "feat: EngineManager - locked synchronous hot-swap + chunk namespace"
```

---

### Task 11: Server — state migration, manager wiring, new endpoints

**Files:**
- Modify: `server.py`
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `EngineManager` surface (Task 10), `engine_catalog` (Task 7), `CloneError` (Task 8), `chunk_id(namespace, text)` + `worker.set_doc(chunks, namespace, position)` (Task 6).
- Produces (frontend relies on these in Task 13):
  - `migrate_state(loaded: dict) -> dict` (module-level, also used by `main()`).
  - `DEFAULT_STATE = {"positions": {}, "voices": {"kokoro": "af_heart"}, "speed": 1.0, "volume": 1.0, "engine": "kokoro", "device_mode": "auto", "instruct": ""}`.
  - `create_app(data_dir, worker, audio_wait=30.0, manager=None, engines=None)` — `engines` overrides the catalog for tests (defaults to `registry.engine_catalog`).
  - Endpoints: `GET /api/engines`; `GET /api/voices` → `{voices: [{id,name,group,language}], current}`; `POST /api/state` accepting `engine/device_mode/instruct/voice/...`; `POST /api/voices/clone?name=&language=`; `DELETE /api/voices/{vid}`; `GET /api/status` engine block with `engine/label/cold/blocked`.

- [ ] **Step 1: Update the fakes and add failing tests**

In `tests/test_server.py`, replace `FakeEngine` with `FakeManager` and update `FakeWorker`:

```python
class FakeWorker:
    # ... keep everything, but:
    def set_doc(self, chunks, namespace, position=0):
        self.docs.append((list(chunks), namespace, position))

    def status(self):
        return {"ready": [], "failed": [], "durations": {}, "blocked": None}


class FakeManager:
    """Mirrors EngineManager's surface with two toy engines."""

    CATALOG = [
        {"id": "kokoro", "label": "Kokoro-82M", "available": True, "reason": None,
         "supported_modes": ["auto", "gpu", "cpu"]},
        {"id": "qwen3", "label": "Qwen3-TTS 0.6B", "available": True, "reason": None,
         "supported_modes": ["auto", "gpu"]},
    ]
    VOICES = {"kokoro": [Voice("af_heart", "Heart", "US female", "en-US"),
                         Voice("am_adam", "Adam", "US male", "en-US")],
              "qwen3": [Voice("Ryan", "Ryan", "English male", "English")]}
    DEFAULTS = {"kokoro": "af_heart", "qwen3": "Ryan"}

    def __init__(self):
        self.engine_id = "kokoro"
        self.sample_rate = 24000
        self.instructs, self.modes, self.swaps = [], [], []
        self.clone_store = None       # set by tests that need it

    def swap(self, engine_id, mode):
        if engine_id not in self.VOICES:
            raise ValueError("unknown engine: " + engine_id)
        self.swaps.append((engine_id, mode))
        self.engine_id = engine_id

    def chunk_namespace(self, voice_id):
        return f"{self.engine_id}\x00fp\x00{voice_id}"

    def voices(self):
        return self.VOICES[self.engine_id]

    def default_voice(self):
        return self.DEFAULTS[self.engine_id]

    def supported_modes(self):
        return next(e["supported_modes"] for e in self.CATALOG if e["id"] == self.engine_id)

    def set_mode(self, mode):
        self.modes.append(mode)

    def set_instruct(self, text):
        self.instructs.append(text)

    def info(self):
        return {"engine": self.engine_id, "label": "x", "cold": False,
                "mode": "auto", "active": "gpu", "gpu_available": True}
```

New tests (add; also mechanically update existing tests that construct the app or assert `set_doc`'s second arg — it is now the namespace `f"kokoro\x00fp\x00{voice}"`):

```python
def make_app(tmp_path, worker=None, manager=None):
    worker = worker or FakeWorker(tmp_path / "cache")
    manager = manager or FakeManager()
    app = create_app(tmp_path, worker, manager=manager, engines=lambda: FakeManager.CATALOG)
    return app, worker, manager


def test_state_migration_from_v2():
    migrated = migrate_state({"positions": {"d": 3}, "voice": "am_adam",
                              "speed": 1.5, "volume": 0.8, "engine": "cpu"})
    assert migrated["device_mode"] == "cpu"          # old engine field was a device mode
    assert migrated["engine"] == "kokoro"
    assert migrated["voices"] == {"kokoro": "am_adam"}
    assert "voice" not in migrated


def test_engines_endpoint(tmp_path):
    app, _, _ = make_app(tmp_path)
    with TestClient(app) as client:
        body = client.get("/api/engines").json()
        assert [e["id"] for e in body["engines"]] == ["kokoro", "qwen3"]
        assert body["current"] == "kokoro"


def test_voices_endpoint_is_structured(tmp_path):
    app, _, _ = make_app(tmp_path)
    with TestClient(app) as client:
        body = client.get("/api/voices").json()
        assert body["voices"][0] == {"id": "af_heart", "name": "Heart",
                                     "group": "US female", "language": "en-US"}
        assert body["current"] == "af_heart"


def test_engine_swap_switches_voice_and_rechunks(tmp_path):
    (tmp_path / "novel.txt").write_text("Hello world.")
    app, worker, manager = make_app(tmp_path)
    with TestClient(app) as client:
        r = client.post("/api/state", json={"engine": "qwen3"})
        assert r.json()["rechunked"] is True
        assert manager.swaps == [("qwen3", "auto")]
        assert worker.docs[-1][1].startswith("qwen3\x00")        # new namespace
        state = json.loads((tmp_path / "state.json").read_text())
        assert state["engine"] == "qwen3"
        assert state["voices"]["qwen3"] == "Ryan"                # per-engine default
        # swapping back remembers the kokoro voice
        client.post("/api/state", json={"engine": "kokoro"})
        assert json.loads((tmp_path / "state.json").read_text())["voices"]["kokoro"] == "af_heart"


def test_device_mode_validated_per_engine(tmp_path):
    app, _, manager = make_app(tmp_path)
    with TestClient(app) as client:
        client.post("/api/state", json={"engine": "qwen3"})
        assert client.post("/api/state", json={"device_mode": "cpu"}).status_code == 400
        assert client.post("/api/state", json={"device_mode": "gpu"}).status_code == 200
        assert manager.modes == ["gpu"]


def test_instruct_rechunks(tmp_path):
    (tmp_path / "novel.txt").write_text("Hello world.")
    app, _, manager = make_app(tmp_path)
    with TestClient(app) as client:
        r = client.post("/api/state", json={"instruct": "read it calmly"})
        assert r.json()["rechunked"] is True
        assert manager.instructs == ["read it calmly"]


def test_unknown_engine_and_voice_rejected(tmp_path):
    app, _, _ = make_app(tmp_path)
    with TestClient(app) as client:
        assert client.post("/api/state", json={"engine": "espeak"}).status_code == 400
        assert client.post("/api/state", json={"voice": "Ryan"}).status_code == 400  # not in kokoro catalog


def test_clone_upload_and_delete(tmp_path):
    from tts.voices import CloneStore
    from tests.test_voices import clip_bytes
    manager = FakeManager()
    manager.clone_store = CloneStore(tmp_path / "voices")
    app, _, _ = make_app(tmp_path, manager=manager)
    with TestClient(app) as client:
        r = client.post("/api/voices/clone?name=Narrator%20A", content=clip_bytes())
        assert r.status_code == 200 and r.json()["voice"]["id"].startswith("clone:")
        vid = r.json()["voice"]["id"]
        assert client.post("/api/voices/clone?name=X", content=b"junk").status_code == 400
        assert client.delete(f"/api/voices/{vid}").status_code == 200
        assert client.delete(f"/api/voices/{vid}").status_code == 404
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `.venv/bin/pytest tests/test_server.py -v`
Expected: new tests FAIL (`migrate_state` undefined, unknown `manager=` kwarg).

- [ ] **Step 3: Implement in `server.py`**

Top of file — imports become `from tts.registry import engine_catalog` and `from tts.voices import CloneError` (drop `from tts import ENGINE_MODES, VOICES`); new default + migration:

```python
DEFAULT_STATE = {"positions": {}, "voices": {"kokoro": "af_heart"}, "speed": 1.0,
                 "volume": 1.0, "engine": "kokoro", "device_mode": "auto", "instruct": ""}
_ENGINE_DEFAULT_VOICE = {"kokoro": "af_heart", "qwen3": "Ryan"}


def migrate_state(loaded: dict) -> dict:
    """v2 state.json: `engine` held the device mode and `voice` a bare kokoro id."""
    out = dict(loaded)
    if out.get("engine") in ("auto", "gpu", "cpu"):
        out.setdefault("device_mode", out.pop("engine"))
    if isinstance(out.get("voice"), str):
        out.setdefault("voices", {"kokoro": out.pop("voice")})
    return out
```

`AppState.__init__` validation (replacing the `VOICES`/`ENGINE_MODES` checks): run `loaded = migrate_state(loaded)`, then drop `voices` unless `isinstance(dict)`, drop `engine` unless it's a string, drop `device_mode` unless in `("auto","gpu","cpu")`, drop `instruct` unless a string. `AppState` gains `self.manager = manager` and:

```python
    def voice(self) -> str:
        """Current engine's voice, falling back to its default if unknown."""
        eid = self.manager.engine_id
        vid = self.state["voices"].get(eid)
        known = {v.id for v in self.manager.voices()}
        if vid not in known:
            vid = self.manager.default_voice() if hasattr(self.manager, "default_voice") \
                else _ENGINE_DEFAULT_VOICE.get(eid, next(iter(known)))
            self.state["voices"][eid] = vid
        return vid
```

Everywhere `st.state["voice"]` appeared now uses `st.voice()`; `load_doc` and `doc_json`/`known_cid` compute `ns = self.manager.chunk_namespace(voice)` and call `chunk_id(ns, c.text)`; `load_doc` ends with `self.worker.set_doc(self.chunks, ns, position=self.position())`.

`create_app(data_dir, worker, audio_wait=30.0, manager=None, engines=None)`:
- `engines = engines or engine_catalog`; at startup: `manager.set_mode` guarded to valid mode, `manager.set_instruct(st.state["instruct"])`.
- `GET /api/engines` → `{"engines": engines(), "current": manager.engine_id}`.
- `GET /api/voices` → `{"voices": [asdict(v) for v in manager.voices()], "current": st.voice()}` (`from dataclasses import asdict`).
- `POST /api/state` (replacing the old engine/voice arms — order: engine, device_mode, instruct, voice, then position/speed/volume as today):

```python
            if body.engine is not None and body.engine != manager.engine_id:
                try:
                    manager.swap(body.engine, st.state["device_mode"])
                except ValueError as exc:
                    raise HTTPException(400, str(exc))
                st.state["engine"] = body.engine
                manager.set_instruct(st.state["instruct"])
                st.load_doc()                      # new namespace -> new cids
                rechunked = True
            if body.device_mode is not None:
                if body.device_mode not in manager.supported_modes():
                    raise HTTPException(400, "unsupported device mode for this engine")
                st.state["device_mode"] = body.device_mode
                manager.set_mode(body.device_mode)
            if body.instruct is not None and body.instruct != st.state["instruct"]:
                st.state["instruct"] = body.instruct
                manager.set_instruct(body.instruct)
                st.load_doc()                      # instruct is in preset fingerprints
                rechunked = True
            if body.voice is not None and body.voice != st.voice():
                if body.voice not in {v.id for v in manager.voices()}:
                    raise HTTPException(400, "unknown voice")
                st.state["voices"][manager.engine_id] = body.voice
                st.load_doc()
                rechunked = True
```

(`StateBody` gains `device_mode: str | None = None` and `instruct: str | None = None`; `engine` stays but now carries an engine id.)
- Clone endpoints:

```python
    @app.post("/api/voices/clone")
    async def post_clone(request: Request, name: str, language: str = "en"):
        data = await request.body()
        try:
            voice = manager.clone_store.add(data, name=name, language=language)
        except CloneError as exc:
            raise HTTPException(400, str(exc))
        return {"voice": asdict(voice)}

    @app.delete("/api/voices/{vid}")
    def delete_clone(vid: str):
        if not manager.clone_store.delete(vid):
            raise HTTPException(404, "unknown or non-cloned voice")
        with st.lock:
            if st.state["voices"].get("qwen3") == vid:
                st.state["voices"].pop("qwen3")    # falls back to default on next use
                if manager.engine_id == "qwen3":
                    st.load_doc()
                st.save_state()
        return {"ok": True}
```

- `GET /api/status` engine block: `out["engine"] = {**manager.info(), "speed": round(getattr(worker, "speed", 0.0), 2)}` — `blocked` rides in `worker.status()` already.
- `main()`: peek becomes

```python
    try:
        peek = migrate_state(json.loads((root / "state.json").read_text()))
    except (OSError, json.JSONDecodeError, AttributeError):
        peek = {}
    engine_id = peek.get("engine") if peek.get("engine") in ("kokoro", "qwen3") else "kokoro"
    mode = peek.get("device_mode", "auto")
    try:
        manager = EngineManager(root, engine_id=engine_id, mode=mode)
    except ValueError:                             # e.g. qwen-tts uninstalled since
        manager = EngineManager(root, engine_id="kokoro", mode=mode)
    worker = TTSWorker(root / "cache", manager)
    app = create_app(root, worker, manager=manager)
```

`EngineManager` gains a tiny `default_voice()` (returns `self._engine.default_voice`) — add it in this task with a one-line test in `tests/test_manager.py`.

- [ ] **Step 4: Run the full fast suite**

Run: `.venv/bin/pytest -m "not slow" -v`
Expected: all pass. Then remove the `VOICES`/`ENGINE_MODES`/`SAMPLE_RATE` shims from `tts/__init__.py` and `tts/kokoro.py`'s alias, re-run, confirm nothing imports them (`grep -rn "ENGINE_MODES\|from tts import" --include="*.py" .` should show only package-internal uses).

- [ ] **Step 5: Commit**

```bash
git add server.py tests/test_server.py tts/
git commit -m "feat: engine/device_mode/instruct state, engines+clone endpoints, v2 state migration"
```

---

### Task 12: Real-model verification on the 4060 box

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-pluggable-tts-engines-design.md` (addendum numbers if Task 1 deferred)

- [ ] **Step 1: Full suite including slow**

```bash
.venv/bin/pytest -m "not slow" && .venv/bin/pytest -m slow
```
Expected: all pass — kokoro smoke AND the new qwen smoke (first run downloads ~1.8 GB).

- [ ] **Step 2: Manual E2E**

`bash start.sh`, then in the browser: paste a chapter → plays on Kokoro; switch engine to Qwen3 (settings) → status shows "loading model", then playback resumes with Ryan; paste a Japanese paragraph → Qwen3 speaks it (Kokoro silences it); set instruct → chunks regenerate; upload a 5s clip → cloned voice appears and plays; pin device mode CPU on Qwen3 → rejected (400 toast); switch back to Kokoro → old voice remembered.

- [ ] **Step 3: Verify sample rate + clone signature against Task 1's addendum; fix `Qwen3Engine.sample_rate` / the clone call if the bench said otherwise. Commit any fixes.**

```bash
git add -A && git commit -m "fix: qwen3 numbers from 4060 verification"   # only if changes
```

---

### Task 13: Frontend — engine picker, voices, instruct, clones, status

**Files:**
- Modify: `frontend/src/lib/api.ts`, `frontend/src/lib/player.ts`, `frontend/src/components/EngineModePicker.tsx`, `frontend/src/components/VoiceCombobox.tsx`, `frontend/src/components/SettingsDialog.tsx`, `frontend/src/components/PlayerBar.tsx`
- Verify: `npm run lint && npm run build` (no test infra; manual E2E in Task 12 Step 2 covers behavior)

**Interfaces:**
- Consumes: Task 11's API shapes exactly.
- Produces: built `static/` assets (committed, per repo convention).

- [ ] **Step 1: `api.ts` — types + endpoints, delete the regex parser**

Remove `voiceLabel`, `voiceGroup`, `voiceName` (`api.ts:83-101`). Add/replace:

```typescript
export type DeviceMode = "auto" | "gpu" | "cpu"   // was EngineMode

export interface Voice {
  id: string
  name: string
  group: string
  language: string
}

export interface EngineEntry {
  id: string
  label: string
  available: boolean
  reason: string | null
  supported_modes: DeviceMode[]
}

export interface EngineInfo {
  engine: string
  label: string
  mode: DeviceMode
  active: "gpu" | "cpu"
  gpu_available: boolean
  cold: boolean
  speed: number
}

export const getEngines = () => api<{ engines: EngineEntry[]; current: string }>("/api/engines")
export const getVoices = () => api<{ voices: Voice[]; current: string }>("/api/voices")
export const uploadClone = (name: string, data: ArrayBuffer) =>
  api<{ voice: Voice }>(`/api/voices/clone?name=${encodeURIComponent(name)}`, data, "POST", true)
export const deleteClone = (id: string) =>
  api<{ ok: boolean }>(`/api/voices/${encodeURIComponent(id)}`, undefined, "DELETE")
export const voiceLabel = (v: Voice) => `${v.name} · ${v.group}`
```

(Adapt the `api()` helper's signature to allow raw-body POST and DELETE the way `importImage` already posts raw bytes — mirror its existing pattern. `StatusResponse.blocked: string | null` joins the worker status type.)

- [ ] **Step 2: `player.ts` — state setters**

Rename `setEngineMode(m)` → `setDeviceMode(m)` (`POST /api/state {device_mode: m}`); add `setEngine(id: string)` and `setInstruct(text: string)` posting `{engine: id}` / `{instruct: text}`, both following the existing `setVoice` pattern (refetch doc on `rechunked: true`).

- [ ] **Step 3: `EngineModePicker.tsx` — engine cards above device modes**

Keep `ENGINE_OPTIONS` (rename `EngineMode` → `DeviceMode` type usage) as the device-mode list, filtered to the current engine's `supported_modes`. Above it add an engine section fed by `getEngines()`:

```tsx
export function EngineList({ engines, current, engineInfo }: {
  engines: EngineEntry[]; current: string; engineInfo: EngineInfo | null
}) {
  const select = async (id: string) => {
    if (id !== current && !(await player.setEngine(id))) {
      toast.error("Engine switch failed - is the server running?")
    }
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">Engine</Label>
      {engines.map((e) => (
        <button key={e.id} type="button" disabled={!e.available}
          onClick={() => void select(e.id)} aria-pressed={current === e.id}
          className={cn("flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            current === e.id && "bg-secondary")}>
          <AudioLines className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {e.label}
              {current === e.id && engineInfo?.cold ? " · loading model…" : ""}
            </span>
            <span className="block text-xs text-muted-foreground">
              {e.available ? (e.id === "qwen3" ? "Japanese, cloning, style - GPU only" : "Fast, 16 voices, CPU fallback") : e.reason}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
```

Device-mode buttons: `disabled` also when the mode isn't in the current engine's `supported_modes`.

- [ ] **Step 4: `VoiceCombobox.tsx` — group by server metadata**

Fetch `getVoices()`; group `voices` by `v.group` preserving server order (replaces the `voiceGroup()` regex grouping); item label `v.name`, selected label `voiceLabel(v)`. Cloned voices render a small delete (X) button calling `deleteClone(v.id)` with a confirm toast, then refetch.

- [ ] **Step 5: `SettingsDialog.tsx` — instruct + clone upload (Qwen3 only)**

When the current engine is `qwen3`, render:

```tsx
<div className="space-y-2">
  <Label htmlFor="instruct">Style instruction</Label>
  <Input id="instruct" placeholder='e.g. "read calmly, slightly tired"'
    defaultValue={instruct}
    onBlur={(e) => { if (e.target.value !== instruct) void player.setInstruct(e.target.value) }} />
  <p className="text-xs text-muted-foreground">Applies to preset voices; changing it regenerates audio.</p>
</div>
<div className="space-y-2">
  <Label>Clone a voice</Label>
  <Input type="file" accept="audio/*" onChange={async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const name = f.name.replace(/\.[^.]+$/, "")
    try { await uploadClone(name, await f.arrayBuffer()); toast.success(`Voice "${name}" added`) }
    catch (err) { toast.error(err instanceof Error ? err.message : "upload failed") }
  }} />
  <p className="text-xs text-muted-foreground">3-30s clip of one speaker (wav/flac/ogg).</p>
</div>
```

- [ ] **Step 6: `PlayerBar.tsx` — blocked/cold status**

Where the buffering indicator reads status, add: if `status.blocked`, show a muted "paused — GPU busy (Qwen3 has no CPU mode)" line; if `engine.cold` and playback is waiting, show "loading model…".

- [ ] **Step 7: Lint, build, commit**

```bash
cd frontend && npm run lint && npm run build && cd ..
git add frontend/src static/
git commit -m "feat: engine picker, server-driven voice groups, instruct + clone UI"
```

---

### Task 14: Docs

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-23-pluggable-tts-engines-design.md` (status → Implemented)

- [ ] **Step 1: README** — engine section: Kokoro default; Qwen3 via `pip install qwen-tts` (or `-r requirements-qwen.txt` per Task 1's outcome), GPU-only, first use downloads ~1.8 GB/variant; instruct + cloning one-liners; note that switching engine/instruct regenerates cached audio.

- [ ] **Step 2: Commit**

```bash
git add README.md docs/
git commit -m "docs: pluggable engines - README + spec status"
```

---

## Self-review notes (already applied)

- **Spec coverage:** speakability (T3/T5/T9), cache namespace (T6/T10), DevicePolicy extraction + no-CPU pause (T4/T9), variant residency (T9), sync hot-swap handshake (T10), state migration + per-engine voice memory (T11), structured voices + clone API (T8/T11/T13), cold/blocked status (T6/T9/T11/T13), benchmark gate (T1/T12), README (T14). Backfill gating: no change needed (spec: self-limits via `FILL_MIN_SPEED`).
- **Ordering risk:** Task 9's clone-call signature depends on Task 1's recorded addendum; if Task 1 was deferred, Task 9 proceeds with the documented `generate_voice_clone` shape and Task 12 Step 3 reconciles.
- **Type consistency check:** `set_doc(chunks, namespace, position)` (T6) matches server call (T11) and `FakeWorker` (T11); `create_engine(engine_id, mode, clone_store)` (T7) matches manager factory calls (T10) and `Qwen3Engine(mode=, clone_store=)` (T9); `chunk_namespace` format identical in T10 code and T11's `FakeManager`.
