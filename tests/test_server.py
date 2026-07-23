import json
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from chunker import chunk_id
from server import create_app, migrate_state
from tts.base import Voice


class FakeWorker:
    """Mirrors tts.TTSWorker's public API without threads or a model."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.docs = []          # (chunks, namespace, voice, position) calls
        self.positions = []

    def set_doc(self, chunks, namespace, voice="", position=0):
        self.docs.append((list(chunks), namespace, voice, position))

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
        return {"ready": [], "failed": [], "durations": {}, "blocked": None}

    def write_wav(self, cid):
        sf.write(self.path(cid), np.zeros(240, dtype=np.float32), 24000)


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


class AsyncGenWorker(FakeWorker):
    """request() simulates a background generation completing shortly after."""

    def request(self, cid):
        event = threading.Event()
        if self.path(cid).exists():
            event.set()
            return event
        timer = threading.Timer(0.02, self._finish, args=(cid, event))
        timer.daemon = True
        timer.start()
        return event

    def _finish(self, cid, event):
        self.write_wav(cid)
        event.set()


class EvictedFileWorker(FakeWorker):
    """request() returns an already-set event, but the file never exists
    (simulates eviction between generation completing and serve time)."""

    def request(self, cid):
        event = threading.Event()
        event.set()
        return event


def _fake_voice_ids(engine_id, clone_store):
    return {v.id for v in FakeManager.VOICES[engine_id]}


def make_client(tmp_path, worker_cls=FakeWorker, audio_wait=0.05, manager=None):
    worker = worker_cls(tmp_path / "cache")
    manager = manager or FakeManager()
    app = create_app(tmp_path, worker, audio_wait=audio_wait, manager=manager,
                     engines=lambda: FakeManager.CATALOG, voice_ids=_fake_voice_ids)
    return TestClient(app), worker


def make_app(tmp_path, worker=None, manager=None):
    worker = worker or FakeWorker(tmp_path / "cache")
    manager = manager or FakeManager()
    app = create_app(tmp_path, worker, manager=manager, engines=lambda: FakeManager.CATALOG,
                     voice_ids=_fake_voice_ids)
    return app, worker, manager


def test_post_doc_returns_chunks_and_sets_worker(tmp_path):
    client, worker = make_client(tmp_path)
    resp = client.post("/api/doc", json={"text": "Hello there.\nSecond paragraph."})
    body = resp.json()
    assert resp.status_code == 200
    assert [c["text"] for c in body["chunks"]] == ["Hello there.", "Second paragraph."]
    assert body["position"] == 0 and body["voice"] == "af_heart"
    assert (tmp_path / "novel.txt").read_text() == "Hello there.\nSecond paragraph."
    assert worker.docs[-1][1] == FakeManager().chunk_namespace("af_heart")


def test_get_doc_empty_file(tmp_path):
    client, _ = make_client(tmp_path)
    body = client.get("/api/doc").json()
    assert body["chunks"] == []


def test_audio_serves_cached_wav_with_immutable_cache(tmp_path):
    client, worker = make_client(tmp_path)
    client.post("/api/doc", json={"text": "Hello there."})
    cid = chunk_id(FakeManager().chunk_namespace("af_heart"), "Hello there.")
    worker.write_wav(cid)
    resp = client.get(f"/api/audio/{cid}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert "immutable" in resp.headers["cache-control"]


def test_audio_503_when_not_ready_and_404_when_unknown(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "Hello there."})
    cid = chunk_id(FakeManager().chunk_namespace("af_heart"), "Hello there.")
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
    assert saved["voices"]["kokoro"] == "af_heart"


def test_voice_change_rechunks_and_persists(tmp_path):
    client, worker = make_client(tmp_path)
    client.post("/api/doc", json={"text": "Hello there."})
    resp = client.post("/api/state", json={"voice": "am_adam"}).json()
    assert resp["rechunked"] is True
    ns = FakeManager().chunk_namespace("am_adam")
    assert worker.docs[-1][1] == ns
    body = client.get("/api/doc").json()
    assert body["chunks"][0]["id"] == chunk_id(ns, "Hello there.")


def test_voices_endpoint(tmp_path):
    client, _ = make_client(tmp_path)
    body = client.get("/api/voices").json()
    assert any(v["id"] == "af_heart" for v in body["voices"]) and body["current"] == "af_heart"


def test_state_position_is_clamped_to_last_chunk(tmp_path):
    client, worker = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})

    resp = client.post("/api/state", json={"position": 99999})
    assert resp.status_code == 200
    body = client.get("/api/doc").json()
    assert body["position"] == 2  # clamped to last valid chunk index
    assert worker.positions[-1] == 2


def test_state_speed_is_clamped_to_supported_range(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})

    resp = client.post("/api/state", json={"speed": -5})
    assert resp.status_code == 200
    body = client.get("/api/doc").json()
    assert body["speed"] == 0.5


def test_state_volume_is_clamped_and_persisted(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})

    assert client.get("/api/doc").json()["volume"] == 1.0  # default
    resp = client.post("/api/state", json={"volume": 5})
    assert resp.status_code == 200
    assert client.get("/api/doc").json()["volume"] == 1.0  # clamped high
    client.post("/api/state", json={"volume": -0.5})
    assert client.get("/api/doc").json()["volume"] == 0.0  # clamped low
    client.post("/api/state", json={"volume": 0.35})
    # fresh app over the same data_dir = server restart
    client2, _ = make_client(tmp_path)
    assert client2.get("/api/doc").json()["volume"] == 0.35


def test_audio_waits_for_async_generation(tmp_path):
    client, worker = make_client(tmp_path, worker_cls=AsyncGenWorker, audio_wait=2.0)
    client.post("/api/doc", json={"text": "Hello there."})
    cid = chunk_id(FakeManager().chunk_namespace("af_heart"), "Hello there.")
    resp = client.get(f"/api/audio/{cid}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"


def test_audio_503_when_ready_event_but_file_evicted(tmp_path):
    client, worker = make_client(tmp_path, worker_cls=EvictedFileWorker)
    client.post("/api/doc", json={"text": "Hello there."})
    cid = chunk_id(FakeManager().chunk_namespace("af_heart"), "Hello there.")
    resp = client.get(f"/api/audio/{cid}")
    assert resp.status_code == 503


def test_state_json_with_wrong_shape_does_not_crash_startup(tmp_path):
    (tmp_path / "state.json").write_text("[1, 2, 3]")
    client, _ = make_client(tmp_path)
    body = client.get("/api/doc").json()
    assert body["voice"] == "af_heart"


def test_position_survives_restart(tmp_path):
    client, worker = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.post("/api/state", json={"position": 2})
    # fresh app over the same data_dir = server restart
    client2, _ = make_client(tmp_path)
    assert client2.get("/api/doc").json()["position"] == 2


def test_malformed_state_fields_fall_back(tmp_path):
    # wrong types alongside a device_mode that's syntactically valid but
    # unsupported by the persisted engine (qwen3 has no "cpu" mode) - both
    # kinds of bogus persisted state must be absorbed without crashing.
    (tmp_path / "state.json").write_text(json.dumps({
        "positions": None, "voices": "not_a_dict", "speed": "fast", "volume": True,
        "engine": "qwen3", "device_mode": "cpu",
    }))
    manager = FakeManager()
    manager.engine_id = "qwen3"  # mirrors main() constructing the manager on "qwen3"
    app = create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=manager,
                     engines=lambda: FakeManager.CATALOG)
    body = TestClient(app).get("/api/doc").json()
    assert body["voice"] == "Ryan" and body["speed"] == 1.0 and body["volume"] == 1.0
    assert manager.modes == ["auto"]  # cpu unsupported by qwen3 -> corrected at startup


def test_engine_mode_applied_persisted_and_validated(tmp_path):
    manager = FakeManager()
    app = create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=manager,
                     engines=lambda: FakeManager.CATALOG)
    client = TestClient(app)
    assert client.post("/api/state", json={"device_mode": "cpu"}).status_code == 200
    assert manager.modes == ["cpu"]
    assert json.loads((tmp_path / "state.json").read_text())["device_mode"] == "cpu"
    assert client.post("/api/state", json={"device_mode": "abacus"}).status_code == 400
    # fresh app over the same data_dir = server restart: persisted mode is still
    # valid for kokoro, so nothing needs correcting at startup
    manager2 = FakeManager()
    create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=manager2,
              engines=lambda: FakeManager.CATALOG)
    assert manager2.modes == []
    assert json.loads((tmp_path / "state.json").read_text())["device_mode"] == "cpu"


def test_status_includes_engine_info(tmp_path):
    manager = FakeManager()
    app = create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=manager,
                     engines=lambda: FakeManager.CATALOG)
    client = TestClient(app)
    body = client.get("/api/status").json()
    assert body["engine"] == {"engine": "kokoro", "label": "x", "cold": False,
                              "mode": "auto", "active": "gpu", "gpu_available": True,
                              "speed": 0.0}
    assert body["blocked"] is None


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
        assert client.get("/api/doc").json()["instruct"] == ""            # default
        r = client.post("/api/state", json={"instruct": "read it calmly"})
        assert r.json()["rechunked"] is True
        assert manager.instructs == ["read it calmly"]
        # GET /api/doc reflects the persisted instruct - the frontend's
        # settings-dialog read-back path after the rechunk-triggered refetch.
        assert client.get("/api/doc").json()["instruct"] == "read it calmly"


def test_unknown_engine_and_voice_rejected(tmp_path):
    app, _, _ = make_app(tmp_path)
    with TestClient(app) as client:
        assert client.post("/api/state", json={"engine": "espeak"}).status_code == 400
        assert client.post("/api/state", json={"voice": "Ryan"}).status_code == 400  # not in kokoro catalog


def test_combined_engine_voice_rejected_atomically(tmp_path):
    (tmp_path / "novel.txt").write_text("Hello world.")
    app, worker, manager = make_app(tmp_path)
    with TestClient(app) as client:
        docs_before = len(worker.docs)
        r = client.post("/api/state", json={"engine": "qwen3", "voice": "af_heart"})
        assert r.status_code == 400
        assert manager.swaps == [] and manager.engine_id == "kokoro"
        assert len(worker.docs) == docs_before
        assert not (tmp_path / "state.json").exists() or \
            json.loads((tmp_path / "state.json").read_text()).get("engine", "kokoro") == "kokoro"


def test_combined_engine_and_new_engine_voice_applies(tmp_path):
    (tmp_path / "novel.txt").write_text("Hello world.")
    app, worker, manager = make_app(tmp_path)
    with TestClient(app) as client:
        r = client.post("/api/state", json={"engine": "qwen3", "voice": "Ryan"})
        assert r.status_code == 200 and r.json()["rechunked"] is True
        assert manager.swaps == [("qwen3", "auto")]
        state = json.loads((tmp_path / "state.json").read_text())
        assert state["engine"] == "qwen3" and state["voices"]["qwen3"] == "Ryan"


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
