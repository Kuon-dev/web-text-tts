"""FastAPI app: doc/state/status/audio API + static player, novel.txt mtime polling."""
import asyncio
import json
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from chunker import chunk_id, chunk_text, doc_id
from tts import VOICES

log = logging.getLogger("novel-tts")
STATIC_DIR = Path(__file__).parent / "static"
POLL_SECONDS = 1.0
DEFAULT_STATE = {"positions": {}, "voice": "af_heart", "speed": 1.0}


class DocBody(BaseModel):
    text: str


class StateBody(BaseModel):
    position: int | None = None
    voice: str | None = None
    speed: float | None = None


class AppState:
    def __init__(self, data_dir: Path, worker):
        self.novel_path = data_dir / "novel.txt"
        self.state_path = data_dir / "state.json"
        self.worker = worker
        self.lock = threading.Lock()
        self.text = ""
        self.doc_id = ""
        self.chunks = []
        self.mtime = 0.0
        self.state = dict(DEFAULT_STATE)
        if self.state_path.exists():
            try:
                self.state.update(json.loads(self.state_path.read_text()))
            except (json.JSONDecodeError, OSError):
                log.warning("state.json unreadable, starting fresh")

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state, indent=2))

    def position(self) -> int:
        return self.state["positions"].get(self.doc_id, 0)

    def load_doc(self, text: str | None = None):
        """(Re)chunk from `text` or from novel.txt. Under lock."""
        if text is not None:
            self.novel_path.write_text(text, encoding="utf-8")
        raw = self.novel_path.read_text(encoding="utf-8") if self.novel_path.exists() else ""
        self.mtime = self.novel_path.stat().st_mtime if self.novel_path.exists() else 0.0
        self.text = raw
        self.doc_id = doc_id(raw)
        self.chunks = chunk_text(raw)
        self.worker.set_doc(self.chunks, self.state["voice"], position=self.position())

    def doc_json(self) -> dict:
        voice = self.state["voice"]
        return {
            "doc_id": self.doc_id,
            "voice": voice,
            "speed": self.state["speed"],
            "position": min(self.position(), max(len(self.chunks) - 1, 0)),
            "chunks": [
                {"id": chunk_id(voice, c.text), "text": c.text, "para": c.para}
                for c in self.chunks
            ],
        }

    def known_cid(self, cid: str) -> bool:
        voice = self.state["voice"]
        return any(chunk_id(voice, c.text) == cid for c in self.chunks)


def create_app(data_dir: Path, worker, audio_wait: float = 30.0) -> FastAPI:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    st = AppState(data_dir, worker)
    with st.lock:
        st.load_doc()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(_poll_file())
        yield
        task.cancel()

    async def _poll_file():
        while True:
            await asyncio.sleep(POLL_SECONDS)
            try:
                mtime = st.novel_path.stat().st_mtime if st.novel_path.exists() else 0.0
                if mtime != st.mtime:
                    log.info("novel.txt changed, rechunking")
                    with st.lock:
                        st.load_doc()
            except OSError:
                pass

    app = FastAPI(lifespan=lifespan)

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
        return {"doc_id": did, **worker.status()}

    @app.get("/api/voices")
    def get_voices():
        with st.lock:
            return {"voices": VOICES, "current": st.state["voice"]}

    @app.post("/api/state")
    def post_state(body: StateBody):
        rechunked = False
        with st.lock:
            if body.position is not None:
                st.state["positions"][st.doc_id] = body.position
                worker.set_position(body.position)
            if body.speed is not None:
                st.state["speed"] = body.speed
            if body.voice is not None and body.voice != st.state["voice"]:
                if body.voice not in VOICES:
                    raise HTTPException(400, "unknown voice")
                st.state["voice"] = body.voice
                st.load_doc()
                rechunked = True
            st.save_state()
        return {"ok": True, "rechunked": rechunked}

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
    worker = TTSWorker(root / "cache", KokoroEngine())
    app = create_app(root, worker)
    log.info("novel-tts ready: http://localhost:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
