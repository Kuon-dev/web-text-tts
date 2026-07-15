"""FastAPI app: doc/state/status/audio API + static player, novel.txt mtime polling."""
import asyncio
import json
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from chunker import chunk_id, chunk_text, doc_id, doc_images
from images import ImageError, ImageStore
from tts import ENGINE_MODES, VOICES

log = logging.getLogger("novel-tts")
STATIC_DIR = Path(__file__).parent / "static"
POLL_SECONDS = 1.0
DEFAULT_STATE = {"positions": {}, "voice": "af_heart", "speed": 1.0, "volume": 1.0,
                 "engine": "auto"}


class DocBody(BaseModel):
    text: str


class StateBody(BaseModel):
    position: int | None = None
    voice: str | None = None
    speed: float | None = None
    volume: float | None = None
    engine: str | None = None


class ImageFetchBody(BaseModel):
    url: str


class AppState:
    def __init__(self, data_dir: Path, worker):
        self.novel_path = data_dir / "novel.txt"
        self.state_path = data_dir / "state.json"
        self.worker = worker
        self.lock = threading.Lock()
        self.text = ""
        self.doc_id = ""
        self.chunks = []
        self.images = ImageStore(data_dir / "images")
        self.image_refs = []
        self.mtime = 0.0
        self.state = dict(DEFAULT_STATE)
        if self.state_path.exists():
            try:
                loaded = json.loads(self.state_path.read_text())
                if not isinstance(loaded, dict):
                    raise ValueError("state.json is not an object")
                if not isinstance(loaded.get("positions"), dict):
                    loaded.pop("positions", None)
                if loaded.get("voice") not in VOICES:
                    loaded.pop("voice", None)
                if not isinstance(loaded.get("speed"), (int, float)) or isinstance(loaded.get("speed"), bool):
                    loaded.pop("speed", None)
                if not isinstance(loaded.get("volume"), (int, float)) or isinstance(loaded.get("volume"), bool):
                    loaded.pop("volume", None)
                if loaded.get("engine") not in ENGINE_MODES:
                    loaded.pop("engine", None)
                self.state.update(loaded)
            except (json.JSONDecodeError, OSError, ValueError, TypeError):
                log.warning("state.json unreadable, starting fresh")

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state, indent=2))

    def position(self) -> int:
        raw = self.state["positions"].get(self.doc_id, 0)
        return max(0, min(raw, max(len(self.chunks) - 1, 0)))

    def load_doc(self, text: str | None = None):
        """(Re)chunk from `text` or from novel.txt. Under lock."""
        if text is not None:
            self.novel_path.write_text(text, encoding="utf-8")
        raw = self.novel_path.read_text(encoding="utf-8", errors="replace") if self.novel_path.exists() else ""
        self.mtime = self.novel_path.stat().st_mtime if self.novel_path.exists() else 0.0
        self.text = raw
        self.doc_id = doc_id(raw)
        self.chunks = chunk_text(raw)
        self.image_refs = doc_images(raw)
        self.images.prune({r.id for r in self.image_refs})
        self.worker.set_doc(self.chunks, self.state["voice"], position=self.position())

    def doc_json(self) -> dict:
        voice = self.state["voice"]
        return {
            "doc_id": self.doc_id,
            "voice": voice,
            "speed": self.state["speed"],
            "volume": self.state["volume"],
            "position": self.position(),
            "chunks": [
                {"id": chunk_id(voice, c.text), "text": c.text, "para": c.para}
                for c in self.chunks
            ],
            "images": [
                {"id": r.id, "para": r.para, "w": m["w"], "h": m["h"]}
                for r in self.image_refs
                if (m := self.images.meta(r.id)) is not None
            ],
        }

    def known_cid(self, cid: str) -> bool:
        voice = self.state["voice"]
        return any(chunk_id(voice, c.text) == cid for c in self.chunks)


def create_app(data_dir: Path, worker, audio_wait: float = 30.0, engine=None) -> FastAPI:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    st = AppState(data_dir, worker)
    if engine is not None:
        engine.set_mode(st.state["engine"])
    with st.lock:
        st.load_doc()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(_poll_file())
        yield
        task.cancel()

    def _check_reload():
        try:
            mtime = st.novel_path.stat().st_mtime if st.novel_path.exists() else 0.0
            if mtime != st.mtime:
                log.info("novel.txt changed, rechunking")
                with st.lock:
                    st.load_doc()
        except Exception:
            log.exception("poll reload failed")

    async def _poll_file():
        while True:
            await asyncio.sleep(POLL_SECONDS)
            await asyncio.to_thread(_check_reload)

    app = FastAPI(lifespan=lifespan)

    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/doc")
    def get_doc():
        with st.lock:
            return st.doc_json()

    @app.post("/api/doc")
    def post_doc(body: DocBody):
        with st.lock:
            st.load_doc(body.text)
            return st.doc_json()

    @app.get("/api/status")
    def get_status():
        with st.lock:
            did = st.doc_id
        out = {"doc_id": did, **worker.status()}
        if engine is not None:
            out["engine"] = {**engine.info(),
                             "speed": round(getattr(worker, "speed", 0.0), 2)}
        return out

    @app.get("/api/voices")
    def get_voices():
        with st.lock:
            return {"voices": VOICES, "current": st.state["voice"]}

    @app.post("/api/state")
    def post_state(body: StateBody):
        rechunked = False
        with st.lock:
            if body.position is not None:
                pos = max(0, min(body.position, max(len(st.chunks) - 1, 0)))
                st.state["positions"][st.doc_id] = pos
                worker.set_position(pos)
            if body.speed is not None:
                st.state["speed"] = min(3.0, max(0.5, body.speed))
            if body.volume is not None:
                st.state["volume"] = min(1.0, max(0.0, body.volume))
            if body.engine is not None:
                if body.engine not in ENGINE_MODES:
                    raise HTTPException(400, "unknown engine mode")
                st.state["engine"] = body.engine
                if engine is not None:
                    engine.set_mode(body.engine)
            if body.voice is not None and body.voice != st.state["voice"]:
                if body.voice not in VOICES:
                    raise HTTPException(400, "unknown voice")
                st.state["voice"] = body.voice
                st.load_doc()
                rechunked = True
            st.save_state()
        return {"ok": True, "rechunked": rechunked}

    @app.post("/api/image")
    async def post_image(request: Request):
        data = await request.body()
        try:
            return st.images.put(data)
        except ImageError as exc:
            raise HTTPException(400, str(exc))

    @app.post("/api/image/fetch")
    def post_image_fetch(body: ImageFetchBody):
        try:
            return st.images.fetch(body.url)
        except ImageError as exc:
            raise HTTPException(400, str(exc))

    @app.get("/api/image/{iid}")
    def get_image(iid: str):
        if not (len(iid) == 40 and all(c in "0123456789abcdef" for c in iid)):
            raise HTTPException(404, "unknown image")
        media = st.images.media_type(iid)
        if media is None:
            raise HTTPException(404, "unknown image")
        return FileResponse(
            st.images.path(iid), media_type=media,
            headers={"Cache-Control": "max-age=31536000, immutable"},
        )

    @app.get("/api/audio/{cid}")
    def get_audio(cid: str):
        with st.lock:
            if not st.known_cid(cid):
                raise HTTPException(404, "unknown chunk")
        headers = {"Cache-Control": "max-age=86400, immutable"}
        event = worker.request(cid)
        if event.wait(audio_wait) and worker.path(cid).exists():
            return FileResponse(worker.path(cid), media_type="audio/wav", headers=headers)
        raise HTTPException(503, "audio not ready, retry")

    return app


def main():
    import shutil

    import uvicorn
    from tts import KokoroEngine, TTSWorker

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not shutil.which("espeak-ng"):
        log.warning("espeak-ng not found — rare words may mispronounce "
                    "(fix: sudo apt-get install espeak-ng)")
    root = Path(__file__).parent
    # peek at the persisted mode so a "cpu"-pinned engine never even creates
    # a CUDA context (AppState re-validates and applies it in create_app)
    try:
        mode = json.loads((root / "state.json").read_text()).get("engine", "auto")
    except (OSError, json.JSONDecodeError, AttributeError):
        mode = "auto"
    engine = KokoroEngine(mode=mode)
    worker = TTSWorker(root / "cache", engine)
    app = create_app(root, worker, engine=engine)
    log.info("novel-tts ready: http://localhost:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
