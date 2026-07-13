import json
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from chunker import chunk_id
from server import create_app


class FakeWorker:
    """Mirrors tts.TTSWorker's public API without threads or a model."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.docs = []          # (chunks, voice, position) calls
        self.positions = []

    def set_doc(self, chunks, voice, position=0):
        self.docs.append((list(chunks), voice, position))

    def set_position(self, idx):
        self.positions.append(idx)

    def request(self, cid):
        event = threading.Event()
        if self.path(cid).exists():
            event.set()
        return event

    def path(self, cid):
        return self.cache_dir / f"{cid}.wav"

    def status(self):
        return {"ready": [], "failed": []}

    def write_wav(self, cid):
        sf.write(self.path(cid), np.zeros(240, dtype=np.float32), 24000)


def make_client(tmp_path):
    worker = FakeWorker(tmp_path / "cache")
    app = create_app(tmp_path, worker, audio_wait=0.05)
    return TestClient(app), worker


def test_post_doc_returns_chunks_and_sets_worker(tmp_path):
    client, worker = make_client(tmp_path)
    resp = client.post("/api/doc", json={"text": "Hello there.\nSecond paragraph."})
    body = resp.json()
    assert resp.status_code == 200
    assert [c["text"] for c in body["chunks"]] == ["Hello there.", "Second paragraph."]
    assert body["position"] == 0 and body["voice"] == "af_heart"
    assert (tmp_path / "novel.txt").read_text() == "Hello there.\nSecond paragraph."
    assert worker.docs[-1][1] == "af_heart"


def test_get_doc_empty_file(tmp_path):
    client, _ = make_client(tmp_path)
    body = client.get("/api/doc").json()
    assert body["chunks"] == []


def test_audio_serves_cached_wav_with_immutable_cache(tmp_path):
    client, worker = make_client(tmp_path)
    client.post("/api/doc", json={"text": "Hello there."})
    cid = chunk_id("af_heart", "Hello there.")
    worker.write_wav(cid)
    resp = client.get(f"/api/audio/{cid}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert "immutable" in resp.headers["cache-control"]


def test_audio_503_when_not_ready_and_404_when_unknown(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "Hello there."})
    cid = chunk_id("af_heart", "Hello there.")
    assert client.get(f"/api/audio/{cid}").status_code == 503
    assert client.get("/api/audio/deadbeef").status_code == 404


def test_position_persists_per_doc(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.post("/api/state", json={"position": 2})
    # switch docs, then come back: position remembered
    client.post("/api/doc", json={"text": "Other chapter."})
    body = client.post("/api/doc", json={"text": "One.\nTwo.\nThree."}).json()
    assert body["position"] == 2
    saved = json.loads((tmp_path / "state.json").read_text())
    assert saved["voice"] == "af_heart"


def test_voice_change_rechunks_and_persists(tmp_path):
    client, worker = make_client(tmp_path)
    client.post("/api/doc", json={"text": "Hello there."})
    resp = client.post("/api/state", json={"voice": "am_adam"}).json()
    assert resp["rechunked"] is True
    assert worker.docs[-1][1] == "am_adam"
    body = client.get("/api/doc").json()
    assert body["chunks"][0]["id"] == chunk_id("am_adam", "Hello there.")


def test_voices_endpoint(tmp_path):
    client, _ = make_client(tmp_path)
    body = client.get("/api/voices").json()
    assert "af_heart" in body["voices"] and body["current"] == "af_heart"
