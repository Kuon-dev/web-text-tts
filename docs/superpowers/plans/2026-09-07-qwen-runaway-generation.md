# Qwen3 Runaway Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every Qwen3 generation to a text-derived length budget so a runaway (the model failing to emit EOS and breathing for tens of seconds) costs seconds instead of minutes, and fix the two worker bugs found alongside it: stale retries after an engine swap, and probe mode that never batches.

**Architecture:** `TTSEngine` (Template Method in `tts/base.py`) gains an opt-in per-text budget (`overrun_factor`); `synthesize`/`synthesize_many` pass the budget to budgeted engines as `max_seconds`, then regenerate-once-and-truncate any item that comes back over budget. `Qwen3Engine` turns the budget into the library's `max_new_tokens`. `TTSWorker` gains a document epoch that invalidates retries, and moves the fill-probe throttle from per-chunk to per-batch.

**Tech Stack:** Python 3.12, numpy, soundfile, qwen-tts 0.1.1 (torch), pytest. No frontend changes.

**Spec:** `docs/superpowers/specs/2026-09-07-qwen-runaway-generation-design.md`

## Global Constraints

- All paths relative to the repo root (the directory containing `server.py`). Work in the existing git repo.
- Use `.venv311/bin/python` / `.venv311/bin/pytest` locally (the mac has no GPU; the `.venv` there is incomplete). The fast suite `pytest -m "not slow"` must pass after every task, on a machine with no GPU and no `qwen-tts` installed. Never import `torch`, `kokoro`, or `qwen_tts` at module top level in `tts/`.
- Kokoro is byte-for-byte unaffected: `tts/kokoro.py` is not modified by this plan, and no existing test double gains a new parameter.
- Budget formula, verbatim from the spec: `overrun_factor * len(text) / CHARS_PER_SECOND + overrun_floor_s`, with `CHARS_PER_SECOND = 15.0`, Qwen `overrun_factor = 1.6`, `overrun_floor_s = 2.0`. Qwen frame rate `12.5` frames/s; cap = `int(max_seconds * 12.5) + 1`.
- Task 6 needs the L4 (`ssh ai-tokyo-g6-xlarge`, deployment at `/var/tmp/web-text-tts`, a plain copy, not a git checkout). Everything else runs anywhere.
- Commit messages end with the session's Co-Authored-By / Claude-Session trailers (see recent `git log`). Do not commit the pre-existing unrelated `README.md` diff unless the task says so.

---

### Task 1: Length budget on `TTSEngine`

**Files:**
- Modify: `tts/base.py` (class attributes after `sample_rate`, new method after `prepare`)
- Modify: `tts/worker.py:26` (`CHARS_PER_SECOND` moves to base; worker imports it)
- Test: `tests/test_batch.py`

**Interfaces:**
- Produces: `tts.base.CHARS_PER_SECOND: float = 15.0`; `TTSEngine.overrun_factor: ClassVar[float | None] = None`; `TTSEngine.overrun_floor_s: ClassVar[float] = 2.0`; `TTSEngine.budget_seconds(text: str) -> float | None`.
- `tts/__init__.py` keeps re-exporting `CHARS_PER_SECOND` from `.worker` unchanged, because the worker imports the name into its namespace.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_batch.py` (after `BatchEngine`, before `FakeClock`):

```python
class BudgetEngine(BatchEngine):
    """Autoregressive-style engine that can overrun, like Qwen3: declares a
    budget factor and accepts the cap the base class derives from it.
    Texts in `overrun_texts` come back as 60s of audio, whatever the cap."""
    overrun_factor = 1.6

    def __init__(self, policy, seconds=1.0, overrun_texts=()):
        super().__init__(policy, seconds)
        self.overrun_texts = set(overrun_texts)
        self.caps = []                       # max_seconds seen by every model call

    def _length(self, text):
        secs = 60.0 if text in self.overrun_texts else self.seconds
        return int(secs * self.sample_rate)

    def _generate(self, text, voice, device, *, max_seconds=None):
        self.generate_calls.append(text)
        self.caps.append(max_seconds)
        return np.zeros(self._length(text), dtype=np.float32)

    def _generate_batch(self, texts, voice, device, *, max_seconds=None):
        self.batch_calls.append(list(texts))
        self.caps.append(max_seconds)
        return [np.zeros(self._length(t), dtype=np.float32) for t in texts]
```

Append at the end of the file:

```python
def test_engines_without_a_factor_have_no_budget():
    assert ToyEngine(FakePolicy()).budget_seconds("any text at all") is None
    assert BatchEngine(FakePolicy()).budget_seconds("any text at all") is None


def test_budget_is_factor_times_narration_pace_plus_floor():
    engine = BudgetEngine(FakePolicy())

    # 150 chars = 10s at 15 chars/s; 1.6x + 2s floor
    assert engine.budget_seconds("x" * 150) == pytest.approx(18.0)
    # interjections are dominated by the floor
    assert engine.budget_seconds("Mm.") == pytest.approx(1.6 * 3 / 15 + 2.0)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv311/bin/pytest tests/test_batch.py -k "budget" -v`
Expected: 2 FAIL with `AttributeError: 'ToyEngine' object has no attribute 'budget_seconds'` (and the same for `BudgetEngine`).

- [ ] **Step 3: Implement the budget in `tts/base.py`**

Add the constant after `DEVICE_MODES`:

```python
DEVICE_MODES = ("auto", "gpu", "cpu")
CHARS_PER_SECOND = 15.0  # narration pace measured on real chapters
```

Add the class attributes and method to `TTSEngine`, directly after `sample_rate: int = 24000`:

```python
    sample_rate: int = 24000
    # Runaway guard. An autoregressive engine can fail to emit EOS and keep
    # vocalising: Qwen3 0.6B produced 28s of breathing for a 3s line
    # (spec 2026-09-07). An engine that sets overrun_factor gets a per-text
    # budget of  overrun_factor * len(text) / CHARS_PER_SECOND + overrun_floor_s
    # seconds - the cap it hands its model, and the length past which the
    # base class regenerates the item alone and truncates. None disables it
    # (Kokoro: a fixed-length model never overruns).
    overrun_factor: ClassVar[float | None] = None
    overrun_floor_s: ClassVar[float] = 2.0
```

and after `prepare`:

```python
    def budget_seconds(self, text: str) -> float | None:
        """Seconds of audio `text` may produce before it counts as a runaway."""
        if self.overrun_factor is None:
            return None
        return self.overrun_factor * len(text) / CHARS_PER_SECOND + self.overrun_floor_s
```

In `tts/worker.py`, replace the constant definition with an import. Change:

```python
from .base import EngineUnavailable
```

to:

```python
from .base import CHARS_PER_SECOND, EngineUnavailable
```

and delete the line `CHARS_PER_SECOND = 15.0  # narration pace measured on real chapters` (keep the comment block above it; its first sentence still describes the lookahead window). `EST_BYTES_PER_CHAR` and `_pick` keep using the imported name unchanged.

- [ ] **Step 4: Run the fast suite**

Run: `.venv311/bin/pytest -m "not slow" -q`
Expected: all pass, including the 2 new tests and `tests/test_worker.py` (which still imports `CHARS_PER_SECOND` via `tts`).

- [ ] **Step 5: Commit**

```bash
git add tts/base.py tts/worker.py tests/test_batch.py
git commit -m "feat: per-text length budget on TTSEngine (opt-in via overrun_factor)"
```

---

### Task 2: Enforce the budget in `synthesize` and `synthesize_many`

**Files:**
- Modify: `tts/base.py` (`synthesize`, `synthesize_many`, `_generate_batch`, new helpers)
- Test: `tests/test_batch.py`

**Interfaces:**
- Consumes: `budget_seconds`, `overrun_factor` from Task 1; `BudgetEngine`, `ManualClock`, `FakePolicy` doubles in `tests/test_batch.py`.
- Produces: budgeted engines are called as `_generate(text, voice, device, max_seconds=<budget>)` and `_generate_batch(texts, voice, device, max_seconds=<max budget of members>)`. Unbudgeted engines are called with the three positional arguments only. Task 3 implements the keyword on `Qwen3Engine`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_batch.py`:

```python
def test_single_synthesize_receives_its_own_budget():
    engine = BudgetEngine(FakePolicy())

    engine.synthesize("x" * 30, "v1")

    assert engine.caps == [pytest.approx(engine.budget_seconds("x" * 30))]


def test_batch_receives_the_largest_member_budget():
    engine = BudgetEngine(FakePolicy())

    engine.synthesize_many(["x" * 30, "x" * 150, "x" * 60], "v1")

    assert engine.caps == [pytest.approx(engine.budget_seconds("x" * 150))]


def test_unbudgeted_engines_are_called_without_a_cap():
    # BatchEngine/ToyEngine take no max_seconds keyword: passing one would
    # TypeError, so this proves the keyword is only sent to budgeted engines.
    engine = BatchEngine(FakePolicy())

    engine.synthesize_many(["a"], "v1")
    engine.synthesize("a", "v1")

    assert engine.batch_calls == [["a"]]
    assert engine.generate_calls == ["a"]


def test_an_over_budget_item_is_regenerated_alone_and_truncated():
    bad = "Haa... haa... haa... I can't... breathe..."
    engine = BudgetEngine(FakePolicy(), overrun_texts={bad})

    out = engine.synthesize_many(["fine.", bad, "also fine."], "v1")

    assert engine.batch_calls == [["fine.", bad, "also fine."]]
    assert engine.generate_calls == [bad]                   # retried alone, once
    assert engine.caps[-1] == pytest.approx(engine.budget_seconds(bad))
    # the retry still came back at 60s: kept, but cut at the budget
    assert len(out[1]) == int(engine.budget_seconds(bad) * engine.sample_rate)
    # in-budget neighbours are untouched
    assert len(out[0]) == engine.sample_rate
    assert len(out[2]) == engine.sample_rate


def test_an_over_budget_single_item_is_also_regenerated_and_truncated():
    bad = "Haa..."
    engine = BudgetEngine(FakePolicy(), overrun_texts={bad})

    audio = engine.synthesize(bad, "v1")

    assert engine.generate_calls == [bad, bad]
    assert len(audio) == int(engine.budget_seconds(bad) * engine.sample_rate)


def test_an_in_budget_item_is_never_retried():
    engine = BudgetEngine(FakePolicy())

    out = engine.synthesize_many(["fine."], "v1")

    assert engine.generate_calls == []
    assert len(out[0]) == engine.sample_rate


def test_retry_time_counts_toward_the_batch_speed(monkeypatch):
    clock = ManualClock()
    monkeypatch.setattr("tts.base.time.monotonic", clock)
    bad = "Haa..."

    class TimedBudgetEngine(BudgetEngine):
        def _generate_batch(self, texts, voice, device, *, max_seconds=None):
            clock.t += 2.0
            return super()._generate_batch(texts, voice, device, max_seconds=max_seconds)

        def _generate(self, text, voice, device, *, max_seconds=None):
            clock.t += 2.0
            return super()._generate(text, voice, device, max_seconds=max_seconds)

    engine = TimedBudgetEngine(FakePolicy(device="cuda"), seconds=4.0, overrun_texts={bad})

    engine.synthesize_many(["x" * 60, bad], "v1")

    # 2s batch + 2s retry = 4s wall; audio = 4s + the truncated budget
    audio_s = 4.0 + int(engine.budget_seconds(bad) * engine.sample_rate) / engine.sample_rate
    assert engine.policy.measured_speeds == [pytest.approx(audio_s / 4.0)]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv311/bin/pytest tests/test_batch.py -v`
Expected: the 7 new tests FAIL. `test_single_synthesize_receives_its_own_budget` and `test_batch_receives_the_largest_member_budget` fail with `caps == [None]`; the over-budget tests fail on `generate_calls == []` or length `60 * 24000`. `test_unbudgeted_engines_are_called_without_a_cap` passes already (it guards against regressions in Step 3).

- [ ] **Step 3: Implement enforcement in `tts/base.py`**

Add `import logging` to the imports and `log = logging.getLogger("novel-tts")` after them.

Replace the body of `synthesize` from `try:` to `raise` with:

```python
        try:
            audio = self._call_generate(text, voice, device)
            audio = self._enforce_budget(text, audio, voice, device)
        except EngineUnavailable:
            raise                      # a gate, not a generation failure
        except Exception as exc:
            if device == "cuda":
                self.policy.failed(str(exc))
            raise
```

Replace the corresponding block of `synthesize_many`:

```python
        try:
            audio = self._call_generate_batch([t for _, t in batch], voice, device)
            audio = [self._enforce_budget(t, a, voice, device)
                     for (_, t), a in zip(batch, audio)]
        except EngineUnavailable:
            raise                      # a gate, not a generation failure
        except Exception as exc:
            if device == "cuda":
                self.policy.failed(str(exc))
            raise
```

Replace the default `_generate_batch` and add the three helpers next to it:

```python
    def _generate_batch(self, texts: list[str], voice: str, device: str,
                        *, max_seconds: float | None = None) -> list[np.ndarray]:
        return [self._call_generate(t, voice, device) for t in texts]

    def _call_generate(self, text, voice, device):
        budget = self.budget_seconds(text)
        if budget is None:
            return self._generate(text, voice, device)
        return self._generate(text, voice, device, max_seconds=budget)

    def _call_generate_batch(self, texts, voice, device):
        if self.overrun_factor is None:
            return self._generate_batch(texts, voice, device)
        return self._generate_batch(
            texts, voice, device,
            max_seconds=max(self.budget_seconds(t) for t in texts))

    def _enforce_budget(self, text, audio, voice, device):
        """Over budget = the engine hit its cap without an EOS. Try once more
        alone (sampling is stochastic; the second take is usually fine), and
        keep whatever comes back, cut at the budget: at that point the audio
        is already breathing, and a fade would only lengthen it."""
        budget = self.budget_seconds(text)
        if budget is None:
            return audio
        limit = int(budget * self.sample_rate)
        if len(audio) <= limit:
            return audio
        log.warning("runaway: %.1fs of audio for %d chars (budget %.1fs), regenerating alone",
                    len(audio) / self.sample_rate, len(text), budget)
        audio = self._generate(text, voice, device, max_seconds=budget)
        return audio[:limit]
```

Note the base `_generate_batch` signature gains the keyword so an engine that sets `overrun_factor` but keeps the default per-item batching (Qwen's clone path in Task 3) still works; the default implementation passes each item its own budget through `_call_generate`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv311/bin/pytest tests/test_batch.py -v`
Expected: all pass.

- [ ] **Step 5: Run the fast suite**

Run: `.venv311/bin/pytest -m "not slow" -q`
Expected: all pass. `tests/test_base.py`, `tests/test_manager.py`, `tests/test_integration_worker_manager.py` and `tests/test_kokoro_engine.py` prove unbudgeted engines still get three positional arguments.

- [ ] **Step 6: Commit**

```bash
git add tts/base.py tests/test_batch.py
git commit -m "feat: regenerate-once-and-truncate any generation that overruns its budget"
```

---

### Task 3: Qwen3 passes the budget as `max_new_tokens`

**Files:**
- Modify: `tts/qwen.py` (module docstring, constants, `_generate_batch`, `_generate`, new `_cap`)
- Modify: `tests/test_qwen_engine.py` (`fake_qwen` fixture records `max_new_tokens`)
- Test: `tests/test_qwen_engine.py`

**Interfaces:**
- Consumes: `_generate(..., max_seconds=)` / `_generate_batch(..., max_seconds=)` calling convention from Task 2.
- Produces: `tts.qwen.QWEN_FRAMES_PER_SECOND = 12.5`, `tts.qwen.QWEN_OVERRUN_FACTOR = 1.6`, `Qwen3Engine.overrun_factor = QWEN_OVERRUN_FACTOR`, `Qwen3Engine._cap(max_seconds: float | None) -> int | None`.

- [ ] **Step 1: Update the fixture and write the failing tests**

In `tests/test_qwen_engine.py`, change the fake model so both generate methods accept and record the cap. Replace the `FakeModel` methods with:

```python
        def generate_custom_voice(self, *, text, language, speaker, instruct=None,
                                  max_new_tokens=None):
            calls["custom"].append((text, language, speaker, instruct))
            calls["caps"].append(max_new_tokens)
            n = len(text) if isinstance(text, list) else 1
            return [np.zeros(24000, dtype=np.float32) for _ in range(n)], 24000

        def generate_voice_clone(self, *, text, ref_audio, language, max_new_tokens=None):
            calls["clone"].append((text, ref_audio, language))
            calls["caps"].append(max_new_tokens)
            return [np.zeros(24000, dtype=np.float32)], 24000
```

and initialise `calls = {"loaded": [], "custom": [], "clone": [], "caps": []}`.

Append the tests:

```python
def test_qwen_declares_a_budget_and_cap():
    from tts.qwen import QWEN_FRAMES_PER_SECOND, QWEN_OVERRUN_FACTOR, Qwen3Engine
    assert (QWEN_FRAMES_PER_SECOND, QWEN_OVERRUN_FACTOR) == (12.5, 1.6)
    assert Qwen3Engine.overrun_factor == 1.6
    assert Qwen3Engine._cap(None) is None
    # +1 so a capped generation is strictly longer than its budget
    assert Qwen3Engine._cap(18.0) == 226


def test_preset_call_is_capped_at_the_budget_in_codec_frames(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    text = "x" * 150                       # 10s at 15 chars/s -> 1.6x + 2s = 18s

    e.synthesize(text, "Ryan")

    assert e.budget_seconds(text) == pytest.approx(18.0)
    assert fake_qwen["caps"] == [226]


def test_batch_cap_follows_the_longest_member(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)

    e.synthesize_many(["x" * 30, "x" * 150, "x" * 60], "Ryan")

    assert fake_qwen["caps"] == [226]


def test_clone_calls_are_capped_per_item(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")

    e.synthesize_many(["x" * 30, "x" * 150], voice.id)

    # clone path is one model call per item, each with its own budget:
    # 30 chars -> 1.6 * 2s + 2s = 5.2s -> int(5.2 * 12.5) + 1 = 66 frames
    assert fake_qwen["caps"] == [66, 226]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv311/bin/pytest tests/test_qwen_engine.py -v`
Expected: the 4 new tests FAIL (`ImportError` for `QWEN_FRAMES_PER_SECOND`, then `caps == [None]`). Existing tests still pass (the fixture change is additive).

- [ ] **Step 3: Implement in `tts/qwen.py`**

Add to the constants block, after `QWEN_MIN_FREE_BYTES`:

```python
# Runaway guard (spec 2026-09-07). The 0.6B model sometimes never emits EOS
# on breathy or emotive text: "Haa... haa... I can't... breathe..." (44 chars,
# ~3s) came back as 28.4s of continuous breathing at batch 1, and the cache
# held 124 WAVs over 17s for chunks capped at 250 chars. The library's only
# length control is max_new_tokens per call (default 2048 frames = 164s), so
# every call gets the budget the base class derives from the text, in codec
# frames. This also bounds the codec decoder, which pads a whole batch to its
# longest member: a 68s runaway in a 32-wide batch made it OOM on 3.09 GiB.
QWEN_FRAMES_PER_SECOND = 12.5     # 12Hz tokenizer family: 12.5 frames/s per model card
QWEN_OVERRUN_FACTOR = 1.6         # 1.6x the 15 chars/s estimate + the 2s floor
```

In the class body, after `max_batch = QWEN_MAX_BATCH`:

```python
    overrun_factor = QWEN_OVERRUN_FACTOR
```

Add the helper after `_variant_for`:

```python
    @staticmethod
    def _cap(max_seconds: float | None) -> int | None:
        # +1 so a generation that hits the cap is longer than its budget and
        # the base class sees it as a runaway; a natural stop never exceeds it.
        if max_seconds is None:
            return None
        return int(max_seconds * QWEN_FRAMES_PER_SECOND) + 1
```

Replace `_generate_batch` and `_generate`:

```python
    def _generate_batch(self, texts: list[str], voice: str, device: str,
                        *, max_seconds: float | None = None) -> list[np.ndarray]:
        if voice.startswith("clone:"):
            # generate_voice_clone takes a single ref clip per call; the base
            # implementation hands each item its own budget
            return super()._generate_batch(texts, voice, device, max_seconds=max_seconds)
        model = self._load("custom")
        wavs, sr = model.generate_custom_voice(
            text=list(texts), language=_PRESET_LANG.get(voice, "Auto"),
            speaker=voice, instruct=self._instruct or None,
            max_new_tokens=self._cap(max_seconds))
        self.sample_rate = sr
        return [np.asarray(w, dtype=np.float32) for w in wavs]

    def _generate(self, text: str, voice: str, device: str,
                  *, max_seconds: float | None = None) -> np.ndarray:
        # device is always "cuda" here: policy(allow_cpu=False) never returns cpu
        if voice.startswith("clone:"):
            model = self._load("base")
            wavs, sr = model.generate_voice_clone(          # signature per bench addendum
                text=text, ref_audio=str(self._clones.ref_path(voice)),
                language="Auto", max_new_tokens=self._cap(max_seconds))
        else:
            model = self._load("custom")
            wavs, sr = model.generate_custom_voice(
                text=text, language=_PRESET_LANG.get(voice, "Auto"), speaker=voice,
                instruct=self._instruct or None, max_new_tokens=self._cap(max_seconds))
        self.sample_rate = sr
        return np.asarray(wavs[0], dtype=np.float32)
```

Both library entry points accept `max_new_tokens` through `**kwargs` and `_merge_generate_kwargs` (qwen-tts 0.1.1, `qwen_tts/inference/qwen3_tts_model.py`); `None` falls through to the library default, which keeps `scripts/bench_qwen.py` unchanged.

Append one paragraph to the module docstring, after the batching paragraph:

```
Generation length is also unbounded by default: the model can miss EOS and
breathe for a minute. Every call is capped at the base class's text budget
(QWEN_OVERRUN_FACTOR), which is what bounds the decoder's padded batch too.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv311/bin/pytest tests/test_qwen_engine.py -v`
Expected: all pass.

- [ ] **Step 5: Run the fast suite and commit**

Run: `.venv311/bin/pytest -m "not slow" -q`
Expected: all pass.

```bash
git add tts/qwen.py tests/test_qwen_engine.py
git commit -m "fix: cap every Qwen3 generation at its text budget in codec frames"
```

---

### Task 4: Worker drops retries from a superseded document

**Files:**
- Modify: `tts/worker.py` (`__init__`, `set_doc`, `_retry_individually`, `_run`)
- Test: `tests/test_worker.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TTSWorker._epoch: int`, incremented by `set_doc`; `_retry_individually(jobs, voice, epoch)`.

- [ ] **Step 1: Write the failing test**

Add `import threading` to the top of `tests/test_worker.py` (it currently imports only `time` and `pathlib` from the stdlib), then append:

```python
def test_a_failed_batch_is_not_retried_after_the_doc_changed(tmp_path):
    """The engine can be swapped while a batch is in flight (the swap waits
    on the manager lock, then load_doc re-namespaces the worker). Retrying
    the batch's items with the OLD voice hits the NEW engine: on 2026-09-07
    Kokoro was called with the Qwen voice 'Ryan' and failed 30 chunks."""
    release = threading.Event()

    class HoldingEngine(BatchFakeEngine):
        def synthesize_many(self, texts, voice, urgent=False):
            self.batches.append(list(texts))
            release.wait(2.0)                    # the swap lands mid-batch
            raise RuntimeError("whole batch exploded")

    chunks = make_chunks(3)
    engine = HoldingEngine()
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "qwen3-ns", voice="Ryan")
    assert wait_until(lambda: len(engine.batches) == 1)

    worker.set_doc([], "kokoro-ns", voice="af_heart")   # what load_doc does after a swap
    release.set()
    time.sleep(0.3)

    assert engine.calls == []                           # no per-item retries with "Ryan"
    assert list(tmp_path.glob("*.wav")) == []           # nothing written under the old namespace
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv311/bin/pytest tests/test_worker.py::test_a_failed_batch_is_not_retried_after_the_doc_changed -v`
Expected: FAIL: `engine.calls` holds the three chunk texts (the stale retries ran and wrote three WAVs).

- [ ] **Step 3: Implement the epoch in `tts/worker.py`**

In `__init__`, after `self._events = {}`:

```python
        self._epoch = 0          # bumped by set_doc: retries from an older epoch are dropped
```

In `set_doc`, first line inside the `with self._cond:` block:

```python
            self._epoch += 1
```

Replace `_retry_individually`:

```python
    def _retry_individually(self, jobs, voice, epoch) -> None:
        """A batch call died. Re-run its items one at a time so a single bad
        chunk cannot fail the others that happened to share its batch.

        Stops as soon as the document changed underneath the batch: after an
        engine swap the old voice belongs to the wrong engine (Kokoro asked
        for the Qwen voice "Ryan" asserts), and nobody wants the audio."""
        for cid, text in jobs:
            with self._cond:
                if self._epoch != epoch:
                    return
            try:
                audio = self._engine.synthesize(text, voice)
                self._write(cid, audio, self._engine.sample_rate)
                with self._cond:
                    self._settle(cid)
            except EngineUnavailable as exc:
                with self._cond:
                    self._blocked = str(exc)
                    self._attempts[cid] = self._attempts.get(cid, 1) - 1
                return
            except Exception:
                log.exception("chunk %s failed (attempt %d)", cid[:8],
                              self._attempts.get(cid, 0))
                with self._cond:
                    if self._attempts.get(cid, 0) >= MAX_ATTEMPTS:
                        self._failed.add(cid)
        self._enforce_cache_cap()
```

In `_run`, capture the epoch when the batch is picked and use it in both failure paths. The `with self._cond:` block at the top of the loop becomes:

```python
            with self._cond:
                picked = self._pick_batch(self._engine.max_batch)
                if picked is None:
                    self._cond.wait(timeout=1.0)
                    continue
                jobs, urgent = picked
                voice = self._voice
                epoch = self._epoch
                for cid, _ in jobs:
                    self._attempts[cid] = self._attempts.get(cid, 0) + 1
```

and the generic `except Exception:` arm becomes:

```python
            except Exception:
                if len(jobs) > 1:
                    self._retry_individually(jobs, voice, epoch)
                    continue
                cid = jobs[0][0]
                with self._cond:
                    if self._epoch != epoch:
                        continue                       # stale: the doc moved on
                    log.exception("chunk %s failed (attempt %d)", cid[:8],
                                  self._attempts.get(cid, 0))
                    if self._attempts.get(cid, 0) >= MAX_ATTEMPTS:
                        self._failed.add(cid)
```

(`log.exception` inside the lock is fine: it only formats the current exception.)

- [ ] **Step 4: Run the worker tests to verify they pass**

Run: `.venv311/bin/pytest tests/test_worker.py -v`
Expected: all pass, including `test_a_failed_batch_retries_each_item_alone` (same epoch, retries still run) and `test_failed_chunk_marked_after_two_attempts_and_retryable`.

- [ ] **Step 5: Run the fast suite and commit**

Run: `.venv311/bin/pytest -m "not slow" -q`
Expected: all pass.

```bash
git add tts/worker.py tests/test_worker.py
git commit -m "fix: drop batch retries once set_doc has superseded the batch"
```

---

### Task 5: Probe mode hands the engine a full batch

**Files:**
- Modify: `tts/worker.py` (`_pick`, `_pick_batch`)
- Test: `tests/test_worker.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `_pick(exclude=frozenset(), allow_fill=True) -> (cid, text, urgent, fill) | None` (fourth field: True when the chunk came from the back-fill tier). `_pick_batch(limit)` is the only caller and its return shape `(jobs, urgent)` is unchanged. No test calls `_pick` directly.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_worker.py`:

```python
def test_a_slow_probe_still_hands_the_engine_a_full_batch(tmp_path):
    """Below FILL_MIN_SPEED the back-fill tier issues one probe per
    FILL_PROBE_S. A one-CHUNK probe measures serial speed (0.6x on Qwen),
    which keeps the worker in probe mode forever: one chunk every 90s, the
    cadence seen on 2026-08-26. The probe must be a batch so the speed it
    measures is batched decode."""
    chunks = [Chunk(text=f"{i} " + "word " * 179 + "end.", para=i) for i in range(12)]
    cids = [chunk_id("ns", c.text) for c in chunks]
    engine = BatchFakeEngine()               # max_batch 4, instant: speed stays 0 -> probing
    worker = TTSWorker(tmp_path, engine, fill_probe_interval=9999.0)
    for c in cids[:3]:                       # the 180s window (chunks 0-2) is already cached
        worker.path(c).write_bytes(b"")
    worker.set_doc(chunks, "ns", position=0)

    assert wait_until(lambda: len(engine.batches) >= 1)
    time.sleep(0.3)

    # exactly one probe, and it is a full batch from the fill tier
    assert engine.batches == [[c.text for c in chunks[3:7]]]
    assert not worker.path(cids[7]).exists()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv311/bin/pytest tests/test_worker.py::test_a_slow_probe_still_hands_the_engine_a_full_batch -v`
Expected: FAIL with `engine.batches == [[chunks[3].text]]` (a one-chunk probe).

- [ ] **Step 3: Move the probe throttle into `_pick_batch`**

Replace the signature and the fill-tier tail of `_pick`:

```python
    def _pick(self, exclude=frozenset(), allow_fill=True):
        """Under lock: (cid, text, urgent, fill) to generate next, or None.

        `exclude` holds cids already claimed by the batch being assembled.
        `allow_fill` is _pick_batch's per-batch probe decision: while
        generation measures slow, the back-fill tier opens once per
        FILL_PROBE_S for a whole batch, not for a single chunk.
        """
```

The two early returns become four-tuples: `return cid, by_id[cid], True, False` (requests) and `return cid, self._chunks[idx].text, False, False` (window). Then replace everything from `probing = self._speed < self._fill_min_speed` to the end of the method with:

```python
        if not allow_fill:
            return None
        est_bytes_per_char = self._engine.sample_rate * 2 / CHARS_PER_SECOND
        spent = 0.0
        for idx in chain(range(self._position, len(self._cids)),
                         range(0, self._position)):
            spent += len(self._chunks[idx].text) * est_bytes_per_char
            if spent > FILL_BUDGET_BYTES:
                break
            cid = self._cids[idx]
            if (not self.path(cid).exists() and cid not in self._failed
                    and cid not in exclude
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, self._chunks[idx].text, False, True
        return None
```

Replace `_pick_batch`:

```python
    def _pick_batch(self, limit: int):
        """Under lock: ([(cid, text), ...], urgent) or None.

        An urgent chunk is returned alone: somebody is waiting on it, and a
        wide batch would make them wait for its slowest member too.

        The back-fill probe is decided here, once per batch: while measured
        speed is under fill_min_speed the fill tier opens every
        fill_probe_interval, and the whole batch may draw from it. A probe
        of one chunk would measure serial decode (0.6x on Qwen) and keep
        the worker throttled forever.
        """
        now = time.monotonic()
        probing = self._speed < self._fill_min_speed
        allow_fill = (not probing
                      or now - self._last_fill_probe >= self._fill_probe_interval)
        first = self._pick(allow_fill=allow_fill)
        if first is None:
            return None
        cid, text, urgent, fill = first
        jobs, used_fill = [(cid, text)], fill
        if not urgent and limit > 1:
            claimed = {cid}
            while len(jobs) < limit:
                nxt = self._pick(exclude=claimed, allow_fill=allow_fill)
                if nxt is None or nxt[2]:      # nothing left, or an urgent arrived
                    break
                jobs.append((nxt[0], nxt[1]))
                claimed.add(nxt[0])
                used_fill = used_fill or nxt[3]
        if probing and used_fill:
            self._last_fill_probe = now
        return jobs, urgent
```

- [ ] **Step 4: Run the worker tests to verify they pass**

Run: `.venv311/bin/pytest tests/test_worker.py -v`
Expected: all pass. `test_backfill_paused_while_generation_slow_window_still_generated` (single-item engine: exactly one probe chunk) and `test_backfill_resumes_when_generation_measures_fast` must still pass: with `max_batch = 1` the behaviour is unchanged.

- [ ] **Step 5: Run the fast suite and commit**

Run: `.venv311/bin/pytest -m "not slow" -q`
Expected: all pass.

```bash
git add tts/worker.py tests/test_worker.py
git commit -m "fix: back-fill probes are whole batches, so probe mode can measure batched speed"
```

---

### Task 6: L4 verification, README note, spec status

**Files:**
- Create: `tests/test_qwen_runaway_slow.py`
- Modify: `README.md` (Qwen3-TTS extras, the style-instruction bullet)
- Modify: `docs/superpowers/specs/2026-09-07-qwen-runaway-generation-design.md` (Status line)

**Interfaces:**
- Consumes: `Qwen3Engine.synthesize_many` with budgets (Tasks 1-3).

- [ ] **Step 1: Write the slow regression test**

```python
"""Real-model runaway regression: needs a GPU with ~3 GiB free and qwen-tts.

Reproduces the 2026-09-07 finding (spec of the same date): at batch 1 the
0.6B model produced 28.4s of breathing for a 44-char line. With budgets in
place nothing may come back over budget, batched or alone.
"""
import numpy as np
import pytest

pytestmark = pytest.mark.slow

TEXTS = [
    "The gates of the old capital rose out of the morning mist, and for a moment "
    "nobody in the caravan spoke. Kaede tightened her grip on the reins. Whatever "
    "waited past those walls, it could not be worse than another winter on the road.",
    "「I told you already. We leave at first light, and we do not look back.」 "
    "She turned away before he could answer.",
    "「Mm.」",
    "「Eh?」",
    "「───!」",
    "「Haa... haa... haa... I can't... breathe...」",
]


@pytest.fixture(scope="module")
def engine():
    pytest.importorskip("qwen_tts")
    torch = pytest.importorskip("torch")
    if not torch.cuda.is_available():
        pytest.skip("needs CUDA")
    from tts.qwen import Qwen3Engine
    return Qwen3Engine(mode="gpu")


def test_no_batched_item_exceeds_its_budget(engine):
    for _ in range(2):                                   # sampling is stochastic
        out = engine.synthesize_many(TEXTS, "Ryan")
        for text, audio in zip(TEXTS, out):
            budget = engine.budget_seconds(text)
            assert len(audio) <= int(budget * engine.sample_rate), \
                f"{len(audio) / engine.sample_rate:.1f}s > {budget:.1f}s for {text[:30]!r}"
            assert float(np.abs(audio).max()) > 0.01


def test_the_breathing_line_alone_is_bounded(engine):
    text = TEXTS[-1]
    for _ in range(3):
        audio = engine.synthesize(text, "Ryan")
        assert len(audio) <= int(engine.budget_seconds(text) * engine.sample_rate)
```

- [ ] **Step 2: Deploy to the L4 and run it**

The deployment is a plain copy. From the repo root:

```bash
rsync -av --exclude .venv --exclude .venv311 --exclude cache --exclude node_modules \
      --exclude '*.log' --exclude state.json --exclude novel.txt --exclude images \
      --exclude voices --exclude wallpaper \
      ./ ai-tokyo-g6-xlarge:/var/tmp/web-text-tts/
```

The running server holds most of the L4's VRAM (19 GiB observed on 2026-09-07), so the slow test needs it stopped. Only the user decides when; ask before doing this, then:

```bash
ssh ai-tokyo-g6-xlarge 'cd /var/tmp/web-text-tts && pkill -f "python server.py"; sleep 3; \
    .venv/bin/pytest tests/test_qwen_runaway_slow.py -v -m slow 2>&1 | grep -v Warning | tail -20'
```

Expected: 2 passed. Each `synthesize_many` of the six texts takes well under a minute; the runaway line is cut at 6.7s (budget) after at most one retry.

Restart the server the way it was started:

```bash
ssh ai-tokyo-g6-xlarge 'cd /var/tmp/web-text-tts && nohup ./start.sh > start-console.log 2>&1 &'
```

- [ ] **Step 3: Verify through the running server**

Switch the reader to Qwen3 in the UI, paste a chapter, and let the worker back-fill for five minutes. Then:

```bash
ssh ai-tokyo-g6-xlarge 'cd /var/tmp/web-text-tts && grep -c "runaway:" start-console.log; \
    .venv/bin/python - <<EOF
import glob, os, time, wave
now = time.time()
long = [p for p in glob.glob("cache/*.wav") if now - os.path.getmtime(p) < 600
        and wave.open(p).getnframes() / 24000 > 29]
print("new WAVs over 29s:", len(long))
EOF'
```

Expected: `new WAVs over 29s: 0` (the largest possible budget is 28.7s for a 250-char chunk). The `runaway:` count is informational; each one is a retry that worked. Also confirm the probe fix: batches in the console log (`Setting pad_token_id` lines) arrive faster than one per 90s once the window is cached.

- [ ] **Step 4: README and spec status**

In `README.md`, replace the style-instruction bullet:

```markdown
- **Style instruction** (settings, Qwen3 only): "read calmly…" etc. Applies to
  preset voices; regenerates audio if changed. Note: the installed qwen-tts
  (0.1.1) silently ignores instructions on the 0.6B models, so this field has
  no audible effect until a larger variant is wired in.
```

Add a bullet after it:

```markdown
- **Runaway guard** (Qwen3 only): the 0.6B model can miss its stop token on
  breathy lines and huff for a minute. Every generation is capped at
  1.6× the expected narration length + 2s; anything that hits the cap is
  regenerated once and cut there. Look for `runaway:` in the server log.
```

Change the spec's `**Status:** Proposed` to `**Status:** Implemented (verified on the L4, <date>)`.

- [ ] **Step 5: Run the fast suite and commit**

Run: `.venv311/bin/pytest -m "not slow" -q`
Expected: all pass; the slow file is deselected.

```bash
git add tests/test_qwen_runaway_slow.py README.md docs/superpowers/specs/2026-09-07-qwen-runaway-generation-design.md
git commit -m "test: L4 runaway regression, document the guard and the ignored 0.6B instruct"
```

Note: `README.md` already carries an unrelated uncommitted diff. Commit only the hunks from this task (`git add -p README.md`) unless the user says to include the rest.
