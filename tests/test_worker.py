import threading
import time
from pathlib import Path

import numpy as np
import pytest

from chunker import Chunk, chunk_id
from tts import EngineUnavailable, TTSWorker


class FakeEngine:
    sample_rate = 24000
    max_batch = 1

    def __init__(self, fail_texts=()):
        self.fail_texts = set(fail_texts)
        self.calls = []

    def synthesize(self, text, voice, urgent=False):
        self.calls.append(text)
        if text in self.fail_texts:
            raise RuntimeError("boom")
        return np.zeros(1200, dtype=np.float32)

    def synthesize_many(self, texts, voice, urgent=False):
        return [self.synthesize(t, voice, urgent=urgent) for t in texts]


def wait_until(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


def make_chunks(n):
    return [Chunk(text=f"Sentence number {i}.", para=i) for i in range(n)]


def test_generates_lookahead_from_position(tmp_path):
    chunks = make_chunks(3)
    worker = TTSWorker(tmp_path, FakeEngine())
    worker.set_doc(chunks, "af_heart")
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids))
    assert set(worker.status()["ready"]) == set(cids)


def test_request_returns_event_set_when_ready(tmp_path):
    chunks = make_chunks(1)
    worker = TTSWorker(tmp_path, FakeEngine())
    worker.set_doc(chunks, "af_heart")
    cid = chunk_id("af_heart", chunks[0].text)
    event = worker.request(cid)
    assert event.wait(5.0)
    assert worker.path(cid).exists()


def test_failed_chunk_marked_after_two_attempts_and_retryable(tmp_path):
    chunks = make_chunks(1)
    engine = FakeEngine(fail_texts={chunks[0].text})
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "af_heart")
    cid = chunk_id("af_heart", chunks[0].text)
    assert wait_until(lambda: cid in worker.status()["failed"])
    assert engine.calls.count(chunks[0].text) == 2
    # click-to-retry: request() clears the failure and tries again
    engine.fail_texts.clear()
    event = worker.request(cid)
    assert event.wait(5.0)
    assert worker.path(cid).exists()


def test_backfills_entire_document_from_position_then_wraps(tmp_path):
    # The worker fills position -> end first (soonest-needed audio), then
    # wraps around to cover rewinds, until the whole document is cached.
    # fill_min_speed=0 opens the speed gate (FakeEngine is instant, so no
    # real speed measurement ever lands).
    chunks = make_chunks(10)
    engine = FakeEngine()
    worker = TTSWorker(tmp_path, engine, fill_min_speed=0.0)
    worker.set_doc(chunks, "af_heart", position=4)
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids))
    expected = [c.text for c in chunks[4:]] + [c.text for c in chunks[:4]]
    assert engine.calls == expected


def test_backfill_stops_short_of_cache_cap(tmp_path):
    # A doc whose estimated audio exceeds the fill budget must make the
    # worker stop, not evict-and-regenerate its own chunks forever.
    from tts import EST_BYTES_PER_CHAR, FILL_BUDGET_BYTES
    per_chunk = int(FILL_BUDGET_BYTES / EST_BYTES_PER_CHAR / 6)  # 6 fit, 7th busts
    chunks = [Chunk(text=f"{i:03d}" + "x" * (per_chunk - 3), para=i) for i in range(8)]
    worker = TTSWorker(tmp_path, FakeEngine(), fill_min_speed=0.0)
    worker.set_doc(chunks, "af_heart", position=0)
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids[:6]))
    time.sleep(0.2)  # give it a chance to overshoot the budget
    assert not worker.path(cids[6]).exists()
    assert not worker.path(cids[7]).exists()


def test_backfill_paused_while_generation_slow_window_still_generated(tmp_path):
    # FakeEngine is instant, so no speed measurement lands and the gate stays
    # shut (default fill_min_speed). The 900-char chunks estimate ~60s each,
    # so the 180s window covers chunks 0-2; the seeded start-up probe allows
    # exactly one back-fill chunk (3), then nothing until the next probe.
    chunks = [Chunk(text=f"{i} " + "word " * 179 + "end.", para=i) for i in range(10)]
    engine = FakeEngine()
    worker = TTSWorker(tmp_path, engine, fill_probe_interval=9999.0)
    worker.set_doc(chunks, "af_heart", position=0)
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids[:4]))
    time.sleep(0.2)  # give it a chance to back-fill past the probe
    assert not worker.path(cids[4]).exists()
    assert engine.calls == [c.text for c in chunks[:4]]


def test_backfill_resumes_when_generation_measures_fast(tmp_path):
    # An engine that measurably outpaces the gate (2s of audio in ~0.31s of
    # wall time ~= 6x realtime) reopens the back-fill beyond the window.
    from tts import SAMPLE_RATE

    class TimedEngine(FakeEngine):
        def synthesize(self, text, voice, urgent=False):
            super().synthesize(text, voice, urgent=urgent)
            time.sleep(0.31)
            return np.zeros(2 * SAMPLE_RATE, dtype=np.float32)

    chunks = [Chunk(text=f"{i} " + "word " * 179 + "end.", para=i) for i in range(6)]
    worker = TTSWorker(tmp_path, TimedEngine(), fill_probe_interval=9999.0)
    worker.set_doc(chunks, "af_heart", position=0)
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids), timeout=10.0)


def test_poison_request_does_not_loop_or_block_later_requests(tmp_path):
    chunks = [Chunk(text="Bad one.", para=0), Chunk(text="Good one.", para=1)]
    engine = FakeEngine(fail_texts={"Bad one."})
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "af_heart")
    bad = chunk_id("af_heart", "Bad one.")
    good = chunk_id("af_heart", "Good one.")
    worker.request(bad)  # re-arms attempts once: at most 2 more tries
    event = worker.request(good)
    assert event.wait(5.0)          # good chunk still gets served
    assert worker.path(good).exists()
    time.sleep(0.3)
    assert engine.calls.count("Bad one.") <= 4   # bounded, not thousands
    assert bad in worker.status()["failed"]


def test_evicted_chunks_always_regenerate(tmp_path):
    # cache eviction of a successfully generated chunk must not consume retry attempts
    chunks = make_chunks(1)
    worker = TTSWorker(tmp_path, FakeEngine())
    worker.set_doc(chunks, "af_heart")
    cid = chunk_id("af_heart", chunks[0].text)
    for _ in range(3):  # evict more times than MAX_ATTEMPTS
        assert wait_until(lambda: worker.path(cid).exists())
        worker.path(cid).unlink()
        worker.set_position(0)  # nudge the worker loop
    assert wait_until(lambda: worker.path(cid).exists())
    assert worker.status()["failed"] == []


def test_status_reports_chunk_durations(tmp_path):
    chunks = make_chunks(2)
    worker = TTSWorker(tmp_path, FakeEngine())
    worker.set_doc(chunks, "af_heart")
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids))
    durations = worker.status()["durations"]
    # FakeEngine returns 1200 samples @ 24kHz = 0.05s per chunk
    assert all(abs(durations[c] - 0.05) < 0.005 for c in cids)


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


def test_engine_receives_bare_voice_not_namespace(tmp_path):
    class VoiceRecorder(FakeEngine):
        def __init__(self):
            super().__init__()
            self.voices = []

        def synthesize(self, text, voice, urgent=False):
            self.voices.append(voice)
            return super().synthesize(text, voice, urgent=urgent)

    engine = VoiceRecorder()
    worker = TTSWorker(tmp_path, engine)
    chunks = make_chunks(1)
    worker.set_doc(chunks, "kokoro\x002\x00af_heart", voice="af_heart")
    cid = chunk_id("kokoro\x002\x00af_heart", chunks[0].text)
    assert wait_until(lambda: worker.path(cid).exists())
    assert engine.voices == ["af_heart"]


class BatchFakeEngine(FakeEngine):
    """max_batch>1, like Qwen3: records the shape of every batch it is handed."""
    max_batch = 4

    def __init__(self, fail_texts=(), batch_fails=False):
        super().__init__(fail_texts)
        self.batches = []
        self.batch_fails = batch_fails

    def synthesize_many(self, texts, voice, urgent=False):
        self.batches.append(list(texts))
        if self.batch_fails:
            raise RuntimeError("whole batch exploded")
        return [self.synthesize(t, voice, urgent=urgent) for t in texts]


def test_batching_engine_is_handed_several_chunks_at_once(tmp_path):
    chunks = make_chunks(8)
    engine = BatchFakeEngine()
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "af_heart")
    cids = [chunk_id("af_heart", c.text) for c in chunks]

    assert wait_until(lambda: all(worker.path(c).exists() for c in cids))
    assert engine.batches, "worker never used the batch entry point"
    assert max(len(b) for b in engine.batches) > 1
    assert all(len(b) <= engine.max_batch for b in engine.batches)


def test_a_single_item_engine_is_never_batched(tmp_path):
    chunks = make_chunks(4)
    engine = FakeEngine()
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "af_heart")
    cids = [chunk_id("af_heart", c.text) for c in chunks]

    assert wait_until(lambda: all(worker.path(c).exists() for c in cids))
    assert engine.calls == [c.text for c in chunks]     # order preserved, one at a time


def test_urgent_request_is_generated_on_its_own(tmp_path):
    chunks = make_chunks(8)
    engine = BatchFakeEngine()
    worker = TTSWorker(tmp_path, engine, fill_min_speed=0.0)
    worker.set_doc(chunks, "af_heart", position=7)
    urgent_cid = chunk_id("af_heart", chunks[7].text)

    assert worker.request(urgent_cid).wait(5.0)
    assert engine.batches[0] == [chunks[7].text]       # served alone, first


def test_a_failed_batch_retries_each_item_alone(tmp_path):
    """One bad chunk must not fail the seven good ones sharing its batch."""
    chunks = make_chunks(4)
    engine = BatchFakeEngine(fail_texts={chunks[2].text})
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "af_heart")
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    good = [c for i, c in enumerate(cids) if i != 2]

    assert wait_until(lambda: all(worker.path(c).exists() for c in good))
    assert not worker.path(cids[2]).exists()
    assert wait_until(lambda: cids[2] in worker.status()["failed"])


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


class BlockingRetryEngine(BatchFakeEngine):
    """Batch call fails immediately; the per-item retry (synthesize) blocks
    on an Event before failing too, so a set_doc landing mid-retry (the
    engine call runs outside the lock) can be observed."""

    def __init__(self, event):
        super().__init__()
        self.event = event

    def synthesize_many(self, texts, voice, urgent=False):
        self.batches.append(list(texts))
        raise RuntimeError("whole batch exploded")

    def synthesize(self, text, voice, urgent=False):
        self.calls.append(text)
        self.event.wait(5.0)
        raise RuntimeError("retry exploded too")


def test_retry_failure_after_the_epoch_moved_on_is_dropped_silently(tmp_path, caplog):
    """The epoch is checked at the top of each _retry_individually iteration,
    but the engine call runs outside the lock: if set_doc lands during it and
    the call raises, the failure must be dropped silently (no attempt, no
    'failed' entry, no log line) because set_doc already cleared this cid's
    state for the new document."""
    event = threading.Event()
    chunks = make_chunks(2)
    engine = BlockingRetryEngine(event)
    worker = TTSWorker(tmp_path, engine)
    worker.set_doc(chunks, "ns")

    assert wait_until(lambda: len(engine.calls) == 1)   # first retry in flight, blocked
    worker.set_doc([], "ns2")                            # epoch moves on mid-retry
    event.set()
    time.sleep(0.3)

    assert worker.status()["failed"] == []
    assert "failed" not in caplog.text
    assert engine.calls == [chunks[0].text]              # loop returned; no 2nd retry


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


class SlowBatchEngine(BatchFakeEngine):
    """Every batch call takes `sleep_s` wall time, like a wide probe batch
    that outlasts a short fill_probe_interval."""

    def __init__(self, sleep_s, fail_texts=()):
        super().__init__(fail_texts)
        self.sleep_s = sleep_s

    def synthesize_many(self, texts, voice, urgent=False):
        self.batches.append(list(texts))
        time.sleep(self.sleep_s)
        return [self.synthesize(t, voice, urgent=urgent) for t in texts]


def test_fill_probe_is_stamped_on_completion_not_at_pick_time(tmp_path):
    """A probe batch that takes longer than fill_probe_interval must not
    reopen the fill tier the instant it returns: the interval is a cooldown
    measured from the batch's COMPLETION, not from when it was picked. At
    pick-time stamping, a probe batch slower than the interval leaves the
    stamp already 'expired' the moment it lands, so the very next pick
    re-opens the fill tier immediately -> continuous back-fill on the
    contended GPU the throttle exists to protect."""
    chunks = [Chunk(text=f"{i} " + "word " * 179 + "end.", para=i) for i in range(12)]
    cids = [chunk_id("ns", c.text) for c in chunks]
    engine = SlowBatchEngine(sleep_s=0.5)    # longer than the 0.2s interval below
    worker = TTSWorker(tmp_path, engine, fill_probe_interval=0.2)
    for c in cids[:3]:                       # the 180s window (chunks 0-2) is already cached
        worker.path(c).write_bytes(b"")
    worker.set_doc(chunks, "ns", position=0)

    assert wait_until(lambda: worker.path(cids[3]).exists(), timeout=5.0)  # first probe landed
    time.sleep(0.1)                          # well under the interval, measured from completion
    assert len(engine.batches) == 1
    assert wait_until(lambda: len(engine.batches) >= 2, timeout=5.0)  # interval elapses
