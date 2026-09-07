# Qwen3 Runaway Generation — Length Budgets for Batched Decode

**Date:** 2026-09-07
**Status:** Implemented (L4 verification pending)
**Extends:** `2026-07-23-pluggable-tts-engines-design.md` (batched decode addendum, 2026-08-20)

## Purpose

Qwen3-TTS 0.6B sometimes fails to stop. On breathy or emotive text it keeps
vocalising after the words are read, producing tens of seconds of huffing and
breathing for a line that should take three. The batching that made Qwen
usable (0.62x -> 10.51x) does not cause this, but it turns one runaway into a
batch-wide problem. This spec bounds every generation to a budget derived from
its text, so a runaway costs a few seconds instead of minutes, and fixes two
worker bugs found while tracing it.

## Findings (2026-09-07, L4, qwen-tts 0.1.1, transformers 4.57.3)

The batch path in `tts/qwen.py` builds each item's prompt exactly as the
single path does. In the library, text is tokenised per item, prompts are
left-padded with a correct attention mask and rope offset, each item is cut at
its own first EOS, and the codec decoder trims each waveform to its own code
length (the two upstream padding fixes of 2026-02-05/06 are in 0.1.1). No
batch-only defect was found in the library or the wrapper.

What was found:

- **The model runs away on its own.** At batch size 1, "Haa... haa... haa...
  I can't... breathe..." (44 chars, ~3s expected) produced 28.4s and 10.2s of
  continuous voiced breathing in two runs. Normal narration and short lines
  ("Mm.", "Eh?") were fine. A 46s WAV in the production cache was written
  while the worker was in single-chunk probe mode, so runaways happen without
  batching in production too.
- **The cache shows the scale.** A chunk is at most 250 chars, so nothing
  legitimate exceeds ~17s at the measured ~15 chars/s. The cache held 124 WAVs
  over 17s and 42 over 20s (longest 68.7s), all loud end to end.
- **Batching amplifies it three ways.** A batch runs until its longest
  member stops, so 31 chunks wait on one runaway. The codec decoder pads all
  members to the longest and decodes them together, and on 2026-09-07 that
  failed 30 times with "Tried to allocate 3.09 GiB", discarding the whole
  batch's work each time. The library's only length control is a per-call
  `max_new_tokens`, and its default of 2048 frames is ~164s of audio per item.
- **Instruct is silently ignored.** `qwen_tts` sets `instruct = None` for
  every 0.6B model, so no style instruction can tame this. Documented here,
  not fixed (see Out of scope).
- **Retry after a swap uses the wrong engine.** `_retry_individually` reads
  the current engine at retry time. The engine was swapped to Kokoro between
  the failed batch and the retries, so Kokoro was called with the Qwen voice
  "Ryan", failed the language assertion, and marked all 30 chunks failed.
- **Probe mode never batches.** Under `FILL_MIN_SPEED` the fill tier issues
  one chunk per `FILL_PROBE_S`. One chunk measures ~0.6x, which keeps the
  worker in probe mode forever: one chunk every 90s (the exact cadence seen on
  2026-08-26 for 45 minutes).

## Requirements

- Every Qwen generation, single or batched, is capped at a frame count
  derived from its text. A cap hit is treated as a runaway, not a result.
- A runaway is regenerated once on its own under the same cap; if it still
  hits the cap, the capped audio is kept, trimmed to the budget. The worker
  never sees an exception for a runaway and never marks the chunk failed.
- Kokoro is byte-for-byte unaffected: budgets are opt-in per engine.
- A failed batch is retried only if the document, voice, and engine it was
  picked for are still current. A stale retry is dropped silently, without
  counting an attempt or logging a failure.
- Probe mode throttles per batch, not per chunk: a probe hands the engine a
  full `max_batch` batch so the measured speed reflects batched decode.
- The fast suite (`.venv/bin/pytest -m "not slow"`) covers all of the above
  without torch or qwen-tts installed.

## Design

### Length budget (`tts/base.py`)

The base class gains one class attribute and one helper:

```python
# Seconds of audio an engine may produce for `text` before it is a runaway.
# None disables the check (Kokoro: a fixed-length model never overruns).
overrun_factor: ClassVar[float | None] = None
overrun_floor_s: ClassVar[float] = 2.0

def budget_seconds(self, text: str) -> float | None:
    if self.overrun_factor is None:
        return None
    return self.overrun_factor * len(text) / CHARS_PER_SECOND + self.overrun_floor_s
```

`CHARS_PER_SECOND` (15.0) moves from `tts/worker.py` to `tts/base.py` and
the worker imports it from there; it is the narration pace both modules
reason about. Measured Qwen output on the L4 runs at 0.92x-1.13x of that
estimate for normal prose, and short interjections ("Mm.") run 1.5-3.5s
regardless of length, which is what the floor absorbs.

Qwen3 sets `overrun_factor = 1.6`. Budgets that produces:

| text | chars | expected | budget |
|------|-------|----------|--------|
| "Mm." | 5 | 0.3s | 2.5s |
| "Haa... haa... haa... I can't... breathe..." | 44 | 2.9s | 6.7s |
| typical sentence | 120 | 8.0s | 14.8s |
| longest chunk | 250 | 16.7s | 28.7s |

The worst case for a 32-wide batch is therefore 28.7s of padding per member,
under 45% of the 68.7s runaway that broke the decoder.

### Enforcement (`tts/base.py`, `synthesize` and `synthesize_many`)

Both entry points already own the timing window. After `_generate` /
`_generate_batch` returns, each item is checked against its budget:

```python
def _enforce_budget(self, text, audio, voice, device) -> np.ndarray:
    budget = self.budget_seconds(text)
    if budget is None or len(audio) <= self._budget_samples(budget):
        return audio
    log.warning("runaway %.1fs for %d chars (budget %.1fs), regenerating alone",
                len(audio) / self.sample_rate, len(text), budget)
    audio = self._generate(text, voice, device)      # one retry, alone
    return audio[: self._budget_samples(budget)]     # keep whatever we got
```

Time spent in the retry is charged to the batch's throughput measurement,
because it is real wall time the reader waits for. The retry is a single
`_generate`, never a nested batch, so the recursion is bounded by design.
The truncation is a hard cut at the budget: at that point the audio is
already breathing, and a fade would only lengthen it.

The cap is what makes "over budget" detectable cheaply. Engines receive the
budget as a keyword so they can pass it to the model:

```python
def _generate(self, text, voice, device, *, max_seconds=None) -> np.ndarray
def _generate_batch(self, texts, voice, device, *, max_seconds=None) -> list[np.ndarray]
```

`max_seconds` for a batch is the largest budget among its members. The
default `_generate_batch` passes each item its own budget. The keyword is
passed only to engines that declare a budget (`overrun_factor` set): an
engine that opts into budgets must accept the cap, and an engine that does
not is called exactly as before. Kokoro and every existing test double are
therefore untouched.

### Qwen3 (`tts/qwen.py`)

```python
QWEN_FRAMES_PER_SECOND = 12.5     # 12Hz tokenizer family, per model card
QWEN_OVERRUN_FACTOR = 1.6

def _cap(self, max_seconds):
    return None if max_seconds is None else int(max_seconds * QWEN_FRAMES_PER_SECOND) + 1
```

Every `generate_custom_voice` / `generate_voice_clone` call passes
`max_new_tokens=self._cap(max_seconds)`. Both library entry points forward
it through `_merge_generate_kwargs`, and a `None` falls back to the library
default, which keeps the benchmark script's behaviour unchanged.

The docstring records the runaway finding next to the batch numbers, so the
next person re-tuning `QWEN_MAX_BATCH` knows that the decoder's padded
memory is bounded by the budget, not by typical chunk length.

### Stale retries (`tts/worker.py`)

`set_doc` increments `self._epoch`. `_pick_batch` returns the epoch it was
picked under, and `_run` carries it into the failure paths:

- `_retry_individually(jobs, voice, epoch)` re-checks `self._epoch == epoch`
  under the lock before every item and returns as soon as it differs.
- The single-chunk failure path logs and counts an attempt only when the
  epoch is unchanged.

The server already calls `load_doc` (and so `set_doc`) after every engine
swap and voice change, so the epoch bump needs no new plumbing. This closes
the swap window for single chunks too, which had the same race in a narrower
form.

### Batched probes (`tts/worker.py`)

`_pick` currently gates the fill tier on `_last_fill_probe` every call, so
the second `_pick` of a batch assembly sees a fresh stamp and returns None.
The gate moves to `_pick_batch`: it decides once whether a probe is due,
passes `allow_fill=True/False` into `_pick`, and stamps `_last_fill_probe`
after the batch is assembled. A probe is then a full batch, its measured
speed reflects batched decode (~10x on the L4), and the worker leaves probe
mode after one probe instead of never.

### Error handling

- A runaway never raises. It is logged at WARNING with both lengths so the
  cache can be audited from the log.
- `EngineUnavailable` from the retry propagates as before: it is a gate, not
  a failure.
- If the codec decoder still OOMs (a batch of 32 maximal budgets is ~28.7s
  each, well inside the 12.3 GiB measured for typical 32-wide batches), the
  existing individual retry handles it, now under the epoch check.

## Testing

Fast suite, no GPU:

- `tests/test_batch.py`: budget math (None for Kokoro-like engines; factor
  and floor for a batch engine); an over-budget item is regenerated alone
  and the retry's audio is truncated to the budget; an in-budget item is
  untouched; the batch call receives `max_seconds` equal to the largest
  member budget; the retry's wall time is included in the measured speed.
- `tests/test_qwen_engine.py`: `max_new_tokens` reaches
  `generate_custom_voice` and `generate_voice_clone` as
  `int(max_seconds * 12.5) + 1`; `None` when no budget.
- `tests/test_worker.py`: a batch failure after `set_doc` produces no retry
  calls, no attempts, no failed chunks; a probe under `FILL_MIN_SPEED`
  hands the engine `max_batch` chunks; probe cadence is still one batch per
  `FILL_PROBE_S`.

Slow / hardware (L4, marked `slow`): the six-text runaway experiment from
2026-09-07 re-run through `Qwen3Engine.synthesize_many` asserts no returned
item exceeds its budget. The 28.4s "Haa..." sample from that day is the
regression case.

## Out of scope (deliberately)

- **Instruct on 0.6B.** The library discards it. Surfacing that in the UI is
  a frontend change with its own spec; until then the README notes it.
- **Length-sorted batches.** Grouping similar-length chunks would tighten
  the per-batch cap, but the budget already bounds decoder padding to 28.7s
  per member, and reordering the priority window changes what plays first.
- **Rejecting on audio content** (silence or breath detection). The budget
  catches every observed runaway by length alone.
- **Re-deriving `QWEN_MIN_SPEED`** and `FILL_MIN_SPEED` from measured
  hardware. Still open from the 2026-08-20 addendum; batched probes make
  the current values survivable.
