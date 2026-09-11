import json
import re
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from chunker import chunk_id
from server import STATIC_DIR, AppState, MAX_BOOKMARK_DOCS, MAX_MARKS, create_app, migrate_state
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
        {"id": "qwen3", "label": "Qwen3-TTS 1.7B", "available": True, "reason": None,
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
        return {"engine": self.engine_id, "label": "x", "loading": False,
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


def make_state(tmp_path):
    """An AppState with no app around it: create_app keeps its state as a
    closure local, and these tests exercise the state directly."""
    return AppState(tmp_path, FakeWorker(tmp_path / "cache"), FakeManager())


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


def test_state_pause_ms_is_clamped_and_persisted(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})

    assert client.get("/api/doc").json()["pause_ms"] == 300  # default
    resp = client.post("/api/state", json={"pause_ms": 99999})
    assert resp.status_code == 200
    assert client.get("/api/doc").json()["pause_ms"] == 2000  # clamped high
    client.post("/api/state", json={"pause_ms": -50})
    assert client.get("/api/doc").json()["pause_ms"] == 0  # clamped low
    client.post("/api/state", json={"pause_ms": 450.7})
    assert client.get("/api/doc").json()["pause_ms"] == 450  # whole milliseconds
    # fresh app over the same data_dir = server restart
    client2, _ = make_client(tmp_path)
    assert client2.get("/api/doc").json()["pause_ms"] == 450


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
        "pause_ms": "long", "engine": "qwen3", "device_mode": "cpu",
    }))
    manager = FakeManager()
    manager.engine_id = "qwen3"  # mirrors main() constructing the manager on "qwen3"
    app = create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=manager,
                     engines=lambda: FakeManager.CATALOG)
    body = TestClient(app).get("/api/doc").json()
    assert body["voice"] == "Ryan" and body["speed"] == 1.0 and body["volume"] == 1.0
    assert body["pause_ms"] == 300
    assert manager.modes == ["auto"]  # cpu unsupported by qwen3 -> corrected at startup


def test_startup_keeps_device_mode_preference_unsupported_by_persisted_engine(tmp_path):
    # device_mode is a user preference, never clobbered: an engine that can't
    # run it just runs "auto" for now, but the preference itself must survive
    # startup untouched so a later engine that supports it can revive it.
    (tmp_path / "state.json").write_text(json.dumps({
        "engine": "qwen3", "device_mode": "cpu",
    }))
    manager = FakeManager()
    manager.engine_id = "qwen3"  # mirrors main() constructing the manager on "qwen3"
    app = create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=manager,
                     engines=lambda: FakeManager.CATALOG)
    assert manager.modes == ["auto"]  # qwen3 has no cpu mode -> engine runs auto
    client = TestClient(app)
    client.post("/api/state", json={})  # no-op POST still flushes st.state to disk
    assert json.loads((tmp_path / "state.json").read_text())["device_mode"] == "cpu"


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
    assert body["engine"] == {"engine": "kokoro", "label": "x", "loading": False,
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


def test_migrate_state_is_idempotent():
    # main() and AppState.__init__ both call migrate_state on whatever's on
    # disk; running it a second time (e.g. on already-migrated state.json)
    # must be a no-op, not re-interpret a real device_mode as a v2 "engine".
    once = migrate_state({"positions": {"d": 3}, "voice": "am_adam",
                          "speed": 1.5, "volume": 0.8, "engine": "cpu"})
    twice = migrate_state(once)
    assert twice == once


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


def test_swap_round_trip_revives_device_mode_preference(tmp_path):
    app, _, manager = make_app(tmp_path)
    with TestClient(app) as client:
        assert client.post("/api/state", json={"device_mode": "cpu"}).status_code == 200
        assert client.post("/api/state", json={"engine": "qwen3"}).status_code == 200
        assert manager.swaps == [("qwen3", "auto")]  # qwen3 has no cpu mode
        assert json.loads((tmp_path / "state.json").read_text())["device_mode"] == "cpu"
        assert client.post("/api/state", json={"engine": "kokoro"}).status_code == 200
        assert manager.swaps == [("qwen3", "auto"), ("kokoro", "cpu")]  # preference revived


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


def test_index_html_root_relative_assets_all_resolve(tmp_path):
    """Regression for the theme-boot.js 404: every root-relative src/href
    static/index.html references must actually be served by this app, not
    just the /assets bundle. This is the FOUC bug's exact class of gap -
    the served page and the routes that exist are checked against each
    other instead of independently."""
    html = (STATIC_DIR / "index.html").read_text()
    paths = set(re.findall(r'(?:src|href)="(/[^"]+)"', html))
    assert paths, "expected index.html to reference at least one root-relative asset"

    app, _, _ = make_app(tmp_path)
    with TestClient(app) as client:
        for path in paths:
            resp = client.get(path)
            assert resp.status_code == 200, f"{path} returned {resp.status_code}"


def test_save_state_is_atomic(tmp_path):
    """A force-quit mid-write must not truncate state.json: the loader falls
    back to defaults on a corrupt file, silently losing position and voice."""
    worker = FakeWorker(tmp_path / "cache")
    app = create_app(tmp_path, worker, manager=FakeManager())
    client = TestClient(app)
    client.post("/api/state", json={"speed": 1.5})
    # no stray temp files left behind
    assert not list(tmp_path.glob("*.tmp"))
    assert json.loads((tmp_path / "state.json").read_text())["speed"] == 1.5


def test_set_bookmarks_sorts_dedupes_and_drops_out_of_range(tmp_path):
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.\nThree.")
    stored = st.set_bookmarks([2, 0, 2, 99, -1])
    assert [m["chunk"] for m in stored] == [0, 2]
    assert stored[0]["excerpt"] == "One."
    assert stored[1]["excerpt"] == "Three."


def test_bookmarks_accessor_drops_indices_past_the_end(tmp_path):
    # A mark stored against a longer version of the document must never read
    # back as "the last sentence" the way a position does - a mis-aimed
    # bookmark is worse than an absent one.
    #
    # This is seeded directly into state rather than via two load_doc() calls:
    # doc_id() hashes the full normalized text (chunker.py), so a genuinely
    # shorter reload is a different document with its own doc_id, not a
    # shrunk version of this one - set_bookmarks() would simply be writing
    # into an unrelated bucket. Poking state directly is the only way to put
    # a stale, too-long chunk index under *this* doc's *current* doc_id.
    st = make_state(tmp_path)
    st.load_doc("One.")
    st.state["bookmarks"][st.doc_id] = [{"chunk": 0, "excerpt": "One."},
                                         {"chunk": 2, "excerpt": "Three."}]
    assert [m["chunk"] for m in st.bookmarks()] == [0]


def test_bookmarks_accessor_dedupes_by_chunk(tmp_path):
    # The stored shape is "sorted by chunk, unique". set_bookmarks dedupes on
    # write and the MCP carry copies an already-clean list, so the only way to
    # breach it is a hand-edited state.json - which is exactly what the
    # accessor's other guards (list-ness, dict-ness, int-ness, range) exist for,
    # and which the design invites by advertising the file as readable by eye.
    #
    # Two entries with the same chunk reach the client as two <div key={2}> on
    # the dock rail and two <CommandItem key={2}> with identical cmdk values:
    # duplicate React keys plus a cmdk identity collision.
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    st.state["bookmarks"][st.doc_id] = [{"chunk": 1, "excerpt": "first"},
                                        {"chunk": 1, "excerpt": "second"},
                                        {"chunk": 0, "excerpt": "One."}]
    # First occurrence wins, and the result is still sorted.
    assert st.bookmarks() == [{"chunk": 0, "excerpt": "One."},
                              {"chunk": 1, "excerpt": "first"}]


def test_set_bookmarks_truncates_at_the_cap_keeping_the_lowest_indices(tmp_path):
    # A backstop against a malformed request, not a UX decision - but an
    # untested cap is a cap that can quietly stop applying.
    st = make_state(tmp_path)
    st.load_doc("\n".join(f"Sentence {n}." for n in range(260)))
    assert len(st.chunks) >= 250
    stored = st.set_bookmarks(list(range(250)))
    assert len(stored) == MAX_MARKS
    # In chunk order, so it is the start of the chapter that survives - the
    # truncation is not "whichever 200 the dict happened to iterate".
    assert [m["chunk"] for m in stored] == list(range(MAX_MARKS))


def test_bookmarks_keep_their_stored_excerpt(tmp_path):
    # The excerpt is what a later re-anchoring pass would match on, so it is
    # stored, not re-derived: re-deriving it would silently make every mark
    # agree with whatever text now sits at that index.
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    st.set_bookmarks([1])
    st.state["bookmarks"][st.doc_id][0]["excerpt"] = "Something else."
    assert st.bookmarks()[0]["excerpt"] == "Something else."


def test_set_bookmarks_with_an_empty_list_removes_the_entry(tmp_path):
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    st.set_bookmarks([1])
    assert st.doc_id in st.state["bookmarks"]
    assert st.set_bookmarks([]) == []
    assert st.doc_id not in st.state["bookmarks"]


def test_bookmarks_map_prunes_to_the_most_recently_written_docs(tmp_path):
    st = make_state(tmp_path)
    first_id = None
    for n in range(MAX_BOOKMARK_DOCS + 1):
        st.load_doc(f"Chapter {n}.\nSecond line.")
        if n == 0:
            first_id = st.doc_id
        st.set_bookmarks([0])
    assert len(st.state["bookmarks"]) == MAX_BOOKMARK_DOCS
    assert first_id not in st.state["bookmarks"]


def test_rewriting_a_doc_refreshes_its_place_in_the_prune_order(tmp_path):
    # Recency is dict insertion order, not a timestamp - so a write must pop
    # and reinsert, or a document marked long ago and marked again today would
    # still be the first one evicted.
    st = make_state(tmp_path)
    st.load_doc("Chapter 0.\nSecond line.")
    oldest = st.doc_id
    st.set_bookmarks([0])
    for n in range(1, MAX_BOOKMARK_DOCS):
        st.load_doc(f"Chapter {n}.\nSecond line.")
        st.set_bookmarks([0])
    st.load_doc("Chapter 0.\nSecond line.")     # touch the oldest again
    st.set_bookmarks([1])
    st.load_doc("Chapter fresh.\nSecond line.")  # pushes the map over the cap
    st.set_bookmarks([0])
    assert oldest in st.state["bookmarks"]


def test_malformed_bookmarks_in_state_json_fall_back(tmp_path):
    (tmp_path / "state.json").write_text(json.dumps({"bookmarks": "not_a_dict"}))
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    assert st.bookmarks() == []
    st.set_bookmarks([0])                       # still writable
    assert [m["chunk"] for m in st.bookmarks()] == [0]


def test_put_bookmarks_stores_and_returns_them(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    resp = client.put("/api/bookmarks", json={"chunks": [2, 0]})
    assert resp.status_code == 200
    assert resp.json()["bookmarks"] == [
        {"chunk": 0, "excerpt": "One."},
        {"chunk": 2, "excerpt": "Three."},
    ]


def test_doc_json_carries_bookmarks(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.put("/api/bookmarks", json={"chunks": [1]})
    assert client.get("/api/doc").json()["bookmarks"] == [{"chunk": 1, "excerpt": "Two."}]


def test_put_bookmarks_drops_out_of_range_indices(tmp_path):
    # Drops, never clamps. That is the feature's central design decision: a
    # position out of range resolves to the last sentence because a resume point
    # is a harmless approximation, but a bookmark silently pointing at the end of
    # the chapter is worse than a bookmark that is gone.
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo."})
    body = client.put("/api/bookmarks", json={"chunks": [0, 99999, -3]}).json()
    assert [m["chunk"] for m in body["bookmarks"]] == [0]


def test_put_bookmarks_ignores_a_write_aimed_at_another_document(tmp_path):
    # The body is otherwise a bare list of indices that applies to whatever
    # document the server holds *now*. An MCP load_text, a paste from another
    # client or the desktop shell can replace the document inside the client's
    # 2s poll window, and a `b` press landing in that window would file the old
    # chapter's indices under the new doc_id - where set_bookmarks fills in the
    # new document's excerpts, so the client's dropStale finds nothing wrong and
    # keeps every one. Fabricated marks on a chapter nobody marked.
    client, _ = make_client(tmp_path)
    stale = client.post("/api/doc", json={"text": "One.\nTwo.\nThree."}).json()["doc_id"]
    client.post("/api/doc", json={"text": "Alpha.\nBeta.\nGamma."})
    client.put("/api/bookmarks", json={"chunks": [1]})       # a real mark on the new doc
    resp = client.put("/api/bookmarks", json={"chunks": [0, 2], "doc_id": stale})
    # 200, not 409: the client's optimistic list is already stale, and the
    # response it gets back is the correction.
    assert resp.status_code == 200
    assert [m["chunk"] for m in resp.json()["bookmarks"]] == [1]
    assert [m["chunk"] for m in client.get("/api/doc").json()["bookmarks"]] == [1]


def test_put_bookmarks_accepts_a_write_that_names_the_current_document(tmp_path):
    client, _ = make_client(tmp_path)
    doc_id = client.post("/api/doc", json={"text": "One.\nTwo.\nThree."}).json()["doc_id"]
    body = client.put("/api/bookmarks", json={"chunks": [2], "doc_id": doc_id}).json()
    assert [m["chunk"] for m in body["bookmarks"]] == [2]


def test_put_bookmarks_without_a_doc_id_still_writes(tmp_path):
    # Optional on purpose: static/ is a committed bundle and the Tauri shell can
    # be running an older one, so a body from before the field existed must keep
    # working rather than silently no-op every mark it sets.
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    body = client.put("/api/bookmarks", json={"chunks": [1]}).json()
    assert [m["chunk"] for m in body["bookmarks"]] == [1]


def test_put_bookmarks_rejects_a_non_integer_list(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo."})
    assert client.put("/api/bookmarks", json={"chunks": ["nope"]}).status_code == 422


def test_bookmarks_are_per_document(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.put("/api/bookmarks", json={"chunks": [2]})
    client.post("/api/doc", json={"text": "Other chapter."})
    assert client.get("/api/doc").json()["bookmarks"] == []
    body = client.post("/api/doc", json={"text": "One.\nTwo.\nThree."}).json()
    assert [m["chunk"] for m in body["bookmarks"]] == [2]


def test_bookmarks_survive_restart(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.put("/api/bookmarks", json={"chunks": [1]})
    # fresh app over the same data_dir = server restart
    client2, _ = make_client(tmp_path)
    client2.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    assert [m["chunk"] for m in client2.get("/api/doc").json()["bookmarks"]] == [1]
