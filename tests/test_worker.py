import time
from pathlib import Path

import numpy as np
import pytest

from chunker import Chunk, chunk_id
from tts import TTSWorker


class FakeEngine:
    def __init__(self, fail_texts=()):
        self.fail_texts = set(fail_texts)
        self.calls = []

    def synthesize(self, text, voice, urgent=False):
        self.calls.append(text)
        if text in self.fail_texts:
            raise RuntimeError("boom")
        return np.zeros(1200, dtype=np.float32)


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


def test_engine_fails_over_to_cpu_when_gpu_slow():
    from tts import GPU_MIN_SPEED, GPU_RETRY_S, KokoroEngine
    e = KokoroEngine.__new__(KokoroEngine)  # skip __init__ (no torch/model needed)
    e.device = "cuda"
    e._gpu_ok = True
    e._gpu_retry_at = 0.0
    e._gpu_retry_wait = GPU_RETRY_S
    assert e._pick_device(urgent=True) == "cuda"
    e._gpu_measured(GPU_MIN_SPEED / 2)  # contended measurement
    assert e._pick_device(urgent=True) == "cpu"   # urgent work never probes
    assert e._pick_device(urgent=False) == "cpu"  # retry window not yet open
    e._gpu_retry_at = 0.0  # pretend the retry backoff has elapsed
    assert e._pick_device(urgent=False) == "cuda"  # non-urgent probe allowed
    e._gpu_measured(GPU_MIN_SPEED * 4)  # probe measured a free GPU
    assert e._pick_device(urgent=True) == "cuda"


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


def test_wordless_text_synthesizes_silence():
    from tts import KokoroEngine, SAMPLE_RATE
    engine = KokoroEngine.__new__(KokoroEngine)  # skip __init__ (no torch/model needed)
    audio = engine.synthesize("◆ ◆ ◆", "af_heart")
    assert len(audio) > 0 and not audio.any()


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
