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

    def synthesize(self, text, voice):
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


def test_set_doc_resets_and_only_generates_lookahead_window(tmp_path):
    chunks = make_chunks(20)
    worker = TTSWorker(tmp_path, FakeEngine())
    worker.set_doc(chunks, "af_heart", position=0)
    cids = [chunk_id("af_heart", c.text) for c in chunks]
    assert wait_until(lambda: all(worker.path(c).exists() for c in cids[:9]))
    time.sleep(0.2)  # give it a chance to overshoot
    assert not worker.path(cids[15]).exists()  # beyond position+8
    worker.set_position(12)
    assert wait_until(lambda: worker.path(cids[15]).exists())
