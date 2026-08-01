"""FastAPI app: doc/state/status/audio/wallpaper API + static player, novel.txt mtime polling."""
import asyncio
import contextlib
import hashlib
import json
import logging
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from chunker import chunk_id, chunk_text, doc_id, doc_images
from images import MAX_IMAGE_BYTES, MEDIA_TYPES, ImageError, ImageStore, sniff
from tts.registry import engine_catalog
from tts.registry import voice_ids as _default_voice_ids
from tts.voices import CloneError

log = logging.getLogger("novel-tts")
STATIC_DIR = Path(__file__).parent / "static"
POLL_SECONDS = 1.0
DEFAULT_STATE = {"positions": {}, "voices": {"kokoro": "af_heart"}, "speed": 1.0,
                 "volume": 1.0, "engine": "kokoro", "device_mode": "auto", "instruct": ""}
_ENGINE_DEFAULT_VOICE = {"kokoro": "af_heart", "qwen3": "Ryan"}

# Origins the Tauri desktop shell can present. Starlette matches allow_origins
# by EXACT STRING, so the custom scheme has to be listed literally — a
# wildcard pattern will not match `tauri://localhost`.
# Deliberately NOT "null": that Origin is forgeable from any sandboxed iframe
# or data: URI, which would let any page the user visits reach these routes.
DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost",
                   "https://tauri.localhost"]


def migrate_state(loaded: dict) -> dict:
    """v2 state.json: `engine` held the device mode and `voice` a bare kokoro id."""
    out = dict(loaded)
    if out.get("engine") in ("auto", "gpu", "cpu"):
        out.setdefault("device_mode", out.pop("engine"))
        out.setdefault("engine", "kokoro")   # v2 only ever had one engine
    if isinstance(out.get("voice"), str):
        out.setdefault("voices", {"kokoro": out.pop("voice")})
    return out


class DocBody(BaseModel):
    text: str


class StateBody(BaseModel):
    position: int | None = None
    voice: str | None = None
    speed: float | None = None
    volume: float | None = None
    engine: str | None = None
    device_mode: str | None = None
    instruct: str | None = None


class ImageFetchBody(BaseModel):
    url: str


class AppState:
    def __init__(self, data_dir: Path, worker, manager):
        self.novel_path = data_dir / "novel.txt"
        self.state_path = data_dir / "state.json"
        self.worker = worker
        self.manager = manager
        self.lock = threading.Lock()
        self.text = ""
        self.doc_id = ""
        self.chunks = []
        self.images = ImageStore(data_dir / "images")
        self.image_refs = []
        self.mtime = 0.0
        # dict(DEFAULT_STATE) is a shallow copy: nested containers (positions,
        # voices) must be copied too, or every AppState would share - and
        # mutate - the same module-level dicts.
        self.state = {**DEFAULT_STATE, "positions": {}, "voices": dict(DEFAULT_STATE["voices"])}
        if self.state_path.exists():
            try:
                loaded = json.loads(self.state_path.read_text())
                if not isinstance(loaded, dict):
                    raise ValueError("state.json is not an object")
                loaded = migrate_state(loaded)
                if not isinstance(loaded.get("positions"), dict):
                    loaded.pop("positions", None)
                if not isinstance(loaded.get("voices"), dict):
                    loaded.pop("voices", None)
                if not isinstance(loaded.get("speed"), (int, float)) or isinstance(loaded.get("speed"), bool):
                    loaded.pop("speed", None)
                if not isinstance(loaded.get("volume"), (int, float)) or isinstance(loaded.get("volume"), bool):
                    loaded.pop("volume", None)
                if not isinstance(loaded.get("engine"), str):
                    loaded.pop("engine", None)
                if loaded.get("device_mode") not in ("auto", "gpu", "cpu"):
                    loaded.pop("device_mode", None)
                if not isinstance(loaded.get("instruct"), str):
                    loaded.pop("instruct", None)
                self.state.update(loaded)
            except (json.JSONDecodeError, OSError, ValueError, TypeError):
                log.warning("state.json unreadable, starting fresh")

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state, indent=2))

    def voice(self) -> str:
        """Current engine's voice, falling back to its default if unknown."""
        eid = self.manager.engine_id
        vid = self.state["voices"].get(eid)
        known = {v.id for v in self.manager.voices()}
        if vid not in known:
            vid = self.manager.default_voice() if hasattr(self.manager, "default_voice") \
                else _ENGINE_DEFAULT_VOICE.get(eid, next(iter(known)))
            self.state["voices"][eid] = vid
        return vid

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
        voice = self.voice()
        ns = self.manager.chunk_namespace(voice)
        self.worker.set_doc(self.chunks, ns, voice, position=self.position())

    def doc_json(self) -> dict:
        voice = self.voice()
        ns = self.manager.chunk_namespace(voice)
        return {
            "doc_id": self.doc_id,
            "voice": voice,
            "speed": self.state["speed"],
            "volume": self.state["volume"],
            "instruct": self.state["instruct"],
            "position": self.position(),
            "chunks": [
                {"id": chunk_id(ns, c.text), "text": c.text, "para": c.para}
                for c in self.chunks
            ],
            "images": [
                {"id": r.id, "para": r.para, "w": m["w"], "h": m["h"]}
                for r in self.image_refs
                if (m := self.images.meta(r.id)) is not None
            ],
        }

    def known_cid(self, cid: str) -> bool:
        ns = self.manager.chunk_namespace(self.voice())
        return any(chunk_id(ns, c.text) == cid for c in self.chunks)


def create_app(data_dir: Path, worker, audio_wait: float = 30.0, *, manager,
               engines=None, voice_ids=None, cors_origins=None) -> FastAPI:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    engines = engines or engine_catalog
    voice_ids = voice_ids or _default_voice_ids
    st = AppState(data_dir, worker, manager)
    # The manager already reflects its persisted mode/instruct from
    # construction (main() builds it with mode=<persisted>); only step in
    # when that's NOT true - an engine-incompatible persisted device_mode
    # (silently downgraded inside the manager, but state.json still shows
    # the stale value) or a persisted instruct the manager never saw at all
    # (EngineManager's constructor has no instruct param).
    # device_mode is a user preference, never clobbered: when the active
    # engine doesn't support it the engine just runs "auto" and the
    # preference stays in st.state, ready to revive on the next engine that
    # supports it (matches the runtime swap arm in post_state below).
    if st.state["device_mode"] not in manager.supported_modes():
        log.info("persisted device_mode %r unsupported by engine %r, running auto "
                  "(preference kept for a future compatible engine)",
                  st.state["device_mode"], manager.engine_id)
        manager.set_mode("auto")
    if st.state["instruct"]:
        manager.set_instruct(st.state["instruct"])
    with st.lock:
        st.load_doc()

    def _build_mcp():
        """The MCP connector, or None when the `mcp` package isn't installed."""
        try:
            from mcp_app import build_mcp
        except ImportError:
            log.warning("mcp package not installed - /mcp connector disabled")
            return None
        return build_mcp(st)

    mcp_server = _build_mcp()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(_poll_file())
        async with contextlib.AsyncExitStack() as stack:
            if mcp_server is not None:
                await stack.enter_async_context(mcp_server.session_manager.run())
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

    # The desktop shell loads its UI from tauri://localhost and calls this
    # server cross-origin. allow_methods=["*"] is what installs the OPTIONS
    # preflight responder — FastAPI has no OPTIONS route for /api/wallpaper or
    # /api/voices/{vid} and would answer 405. allow_credentials stays off:
    # nothing here uses cookies.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[*DESKTOP_ORIGINS, *(cors_origins or [])],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["*"], allow_headers=["*"], max_age=600,
    )

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
        # No st.lock: post_state holds it across blocking manager calls (set_mode/
        # swap/set_instruct wait on the manager lock held by an in-flight synthesize -
        # multi-second on slow engines), and status polling must not freeze behind
        # that. st.doc_id is a str, rebound atomically under the GIL - safe unlocked.
        out = {"doc_id": st.doc_id, **worker.status()}
        out["engine"] = {**manager.info(), "speed": round(getattr(worker, "speed", 0.0), 2)}
        return out

    @app.get("/api/engines")
    def get_engines():
        return {"engines": engines(), "current": manager.engine_id}

    @app.get("/api/voices")
    def get_voices():
        with st.lock:
            return {"voices": [asdict(v) for v in manager.voices()], "current": st.voice()}

    @app.post("/api/state")
    def post_state(body: StateBody):
        rechunked = False
        with st.lock:
            # -- phase 1: validate the whole request before mutating anything
            # (swapping engines is a real side effect - old model unloaded,
            # worker redirected - so a later field failing validation must
            # not leave that swap half-applied). --
            target_engine = body.engine if body.engine is not None else manager.engine_id
            target_entry = next((e for e in engines() if e["id"] == target_engine), None)
            if body.engine is not None:
                if target_entry is None:
                    raise HTTPException(400, f"unknown engine: {body.engine}")
                if not target_entry["available"]:
                    raise HTTPException(400, target_entry["reason"])
            if body.device_mode is not None:
                supported = target_entry["supported_modes"] if target_entry is not None else manager.supported_modes()
                if body.device_mode not in supported:
                    raise HTTPException(400, "unsupported device mode for this engine")
            if body.voice is not None:
                if body.voice not in voice_ids(target_engine, manager.clone_store):
                    raise HTTPException(400, "unknown voice")

            # -- phase 2: apply, now that every field is known-good --
            if body.position is not None:
                pos = max(0, min(body.position, max(len(st.chunks) - 1, 0)))
                st.state["positions"][st.doc_id] = pos
                worker.set_position(pos)
            if body.speed is not None:
                st.state["speed"] = min(3.0, max(0.5, body.speed))
            if body.volume is not None:
                st.state["volume"] = min(1.0, max(0.0, body.volume))
            if body.engine is not None and body.engine != manager.engine_id:
                # device_mode is a preference, never clobbered here: if the target
                # engine doesn't support it it just runs "auto" for now, and
                # switching back to a compatible engine later revives it.
                mode = st.state["device_mode"] if st.state["device_mode"] in target_entry["supported_modes"] else "auto"
                try:
                    manager.swap(body.engine, mode)
                except ValueError as exc:          # belt-and-suspenders: phase 1 already validated
                    raise HTTPException(400, str(exc))
                st.state["engine"] = body.engine
                manager.set_instruct(st.state["instruct"])
                st.load_doc()                      # new namespace -> new cids
                rechunked = True
            if body.device_mode is not None:
                st.state["device_mode"] = body.device_mode
                manager.set_mode(body.device_mode)
            if body.instruct is not None and body.instruct != st.state["instruct"]:
                st.state["instruct"] = body.instruct
                manager.set_instruct(body.instruct)
                st.load_doc()                      # instruct is in preset fingerprints
                rechunked = True
            if body.voice is not None and body.voice != st.voice():
                st.state["voices"][manager.engine_id] = body.voice
                st.load_doc()
                rechunked = True
            st.save_state()
        return {"ok": True, "rechunked": rechunked}

    @app.post("/api/voices/clone")
    async def post_clone(request: Request, name: str, language: str = "en"):
        data = await request.body()
        try:
            voice = manager.clone_store.add(data, name=name, language=language)
        except CloneError as exc:
            raise HTTPException(400, str(exc))
        return {"voice": asdict(voice)}

    @app.delete("/api/voices/{vid}")
    def delete_clone(vid: str):
        if not manager.clone_store.delete(vid):
            raise HTTPException(404, "unknown or non-cloned voice")
        with st.lock:
            if st.state["voices"].get("qwen3") == vid:
                st.state["voices"].pop("qwen3")    # falls back to default on next use
                if manager.engine_id == "qwen3":
                    st.load_doc()
                st.save_state()
        return {"ok": True}

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

    # Wallpaper: one raw image file, format sniffed like illustrations. The
    # frontend cache-busts with ?v=<sha1>, so the served bytes can be immutable.
    wallpaper_path = data_dir / "wallpaper"

    def _wallpaper_info() -> dict | None:
        if not wallpaper_path.exists():
            return None
        data = wallpaper_path.read_bytes()
        info = sniff(data)
        if not info:
            return None
        fmt, w, h = info
        return {"id": hashlib.sha1(data).hexdigest(), "w": w, "h": h, "format": fmt}

    @app.get("/api/wallpaper/info")
    def get_wallpaper_info():
        return {"wallpaper": _wallpaper_info()}

    @app.get("/api/wallpaper")
    def get_wallpaper():
        info = _wallpaper_info()
        if info is None:
            raise HTTPException(404, "no wallpaper set")
        return FileResponse(
            wallpaper_path, media_type=MEDIA_TYPES[info["format"]],
            headers={"Cache-Control": "max-age=31536000, immutable"},
        )

    @app.post("/api/wallpaper")
    async def post_wallpaper(request: Request):
        data = await request.body()
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "image too large (200MB max)")
        if not sniff(data):
            raise HTTPException(400, "unsupported image format (png/jpeg/gif/webp only)")
        wallpaper_path.write_bytes(data)
        return {"wallpaper": _wallpaper_info()}

    @app.delete("/api/wallpaper")
    def delete_wallpaper():
        wallpaper_path.unlink(missing_ok=True)
        return {"wallpaper": None}

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

    if mcp_server is not None:
        # Copy the route rather than app.mount(): a mounted sub-app answers
        # POST /mcp with a 307 to /mcp/, and a redirect mid-handshake is exactly
        # what an MCP client handles worst.
        sub = mcp_server.streamable_http_app(
            streamable_http_path="/mcp", json_response=True, stateless_http=True)
        app.router.routes.extend(sub.routes)

    return app


def main():
    import uvicorn
    from tts import EngineManager, TTSWorker

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    root = Path(__file__).parent
    # peek at the persisted engine/mode so a "cpu"-pinned engine never even
    # creates a CUDA context (create_app re-validates and applies it)
    try:
        peek = migrate_state(json.loads((root / "state.json").read_text()))
    except (OSError, json.JSONDecodeError, AttributeError):
        peek = {}
    engine_id = peek.get("engine") if peek.get("engine") in ("kokoro", "qwen3") else "kokoro"
    mode = peek.get("device_mode", "auto")
    try:
        manager = EngineManager(root, engine_id=engine_id, mode=mode)
    except ValueError:                             # e.g. qwen-tts uninstalled since
        manager = EngineManager(root, engine_id="kokoro", mode=mode)
    worker = TTSWorker(root / "cache", manager)
    app = create_app(root, worker, manager=manager)
    log.info("novel-tts ready: http://localhost:8765")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
