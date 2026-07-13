"""Kokoro engine + background generate-ahead worker writing WAVs to a hash cache."""
import logging
import re
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from chunker import Chunk, chunk_id

log = logging.getLogger("novel-tts")

SAMPLE_RATE = 24000
CACHE_CAP_BYTES = 2 * 1024 ** 3
LOOKAHEAD = 8
MAX_ATTEMPTS = 2

VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova",
    "am_adam", "am_michael", "am_fenrir", "am_puck",
    "bf_emma", "bf_isabella", "bf_lily",
    "bm_george", "bm_lewis", "bm_fable",
]


class KokoroEngine:
    """Lazy per-language KPipeline wrapper. Import cost paid on first synthesize."""

    def __init__(self):
        import torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info("Kokoro device: %s", self.device)
        self._pipelines = {}

    def _pipeline(self, voice: str):
        lang = voice[0]
        if lang not in self._pipelines:
            from kokoro import KPipeline
            self._pipelines[lang] = KPipeline(lang_code=lang, device=self.device)
        return self._pipelines[lang]

    def synthesize(self, text: str, voice: str) -> np.ndarray:
        if not re.search(r"[A-Za-z0-9]", text):
            # scene separators ("***", "* * *", "◆ ◆ ◆") have no speakable
            # content and make Kokoro raise; treat them as a narrator pause.
            return np.zeros(int(0.4 * SAMPLE_RATE), dtype=np.float32)
        import torch
        pieces = []
        for result in self._pipeline(voice)(text, voice=voice):
            audio = getattr(result, "audio", None)
            if audio is None and isinstance(result, tuple):
                audio = result[2]
            if audio is not None:
                pieces.append(audio if isinstance(audio, torch.Tensor) else torch.as_tensor(audio))
        if not pieces:
            raise RuntimeError(f"Kokoro produced no audio for: {text[:60]!r}")
        return torch.cat(pieces).cpu().numpy().astype(np.float32)


class TTSWorker:
    def __init__(self, cache_dir: Path, engine):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._engine = engine
        self._cond = threading.Condition()
        self._chunks: list[Chunk] = []
        self._cids: list[str] = []
        self._voice = ""
        self._position = 0
        self._requests: list[str] = []
        self._attempts: dict[str, int] = {}
        self._failed: set[str] = set()
        self._events: dict[str, threading.Event] = {}
        self._thread = threading.Thread(target=self._run, daemon=True, name="tts-worker")
        self._thread.start()

    # -- public API (thread-safe) ------------------------------------------
    def set_doc(self, chunks: list[Chunk], voice: str, position: int = 0) -> None:
        with self._cond:
            self._chunks = list(chunks)
            self._voice = voice
            self._cids = [chunk_id(voice, c.text) for c in chunks]
            self._position = position
            self._requests.clear()
            self._attempts.clear()
            self._failed.clear()
            self._cond.notify()

    def set_position(self, idx: int) -> None:
        with self._cond:
            self._position = idx
            self._cond.notify()

    def request(self, cid: str) -> threading.Event:
        with self._cond:
            event = self._events.setdefault(cid, threading.Event())
            if self.path(cid).exists():
                event.set()
                return event
            event.clear()
            self._failed.discard(cid)
            self._attempts.pop(cid, None)
            if cid not in self._requests:
                self._requests.append(cid)
            self._cond.notify()
            return event

    def path(self, cid: str) -> Path:
        return self.cache_dir / f"{cid}.wav"

    def status(self) -> dict:
        with self._cond:
            cids, failed = list(self._cids), set(self._failed)
        return {
            "ready": [c for c in cids if self.path(c).exists()],
            "failed": [c for c in cids if c in failed],
        }

    # -- worker loop ---------------------------------------------------------
    def _pick(self):
        """Under lock: (cid, text) to generate next, or None."""
        by_id = dict(zip(self._cids, (c.text for c in self._chunks)))
        for cid in self._requests:
            if (cid in by_id and not self.path(cid).exists()
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, by_id[cid]
        self._requests = [c for c in self._requests
                          if c in by_id and not self.path(c).exists()
                          and self._attempts.get(c, 0) < MAX_ATTEMPTS]
        end = min(self._position + LOOKAHEAD + 1, len(self._cids))
        for idx in range(self._position, end):
            cid = self._cids[idx]
            if (not self.path(cid).exists() and cid not in self._failed
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, self._chunks[idx].text
        return None

    def _run(self):
        while True:
            with self._cond:
                job = self._pick()
                if job is None:
                    self._cond.wait(timeout=1.0)
                    continue
                cid, text = job
                voice = self._voice
                self._attempts[cid] = self._attempts.get(cid, 0) + 1
            try:
                audio = self._engine.synthesize(text, voice)
                tmp = self.path(cid).with_suffix(".tmp")
                sf.write(tmp, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
                tmp.rename(self.path(cid))
                self._enforce_cache_cap()
                with self._cond:
                    self._attempts.pop(cid, None)
                    if cid in self._events:
                        self._events[cid].set()
            except Exception:
                log.exception("chunk %s failed (attempt %d)", cid[:8], self._attempts.get(cid, 0))
                with self._cond:
                    if self._attempts.get(cid, 0) >= MAX_ATTEMPTS:
                        self._failed.add(cid)

    def _enforce_cache_cap(self):
        wavs = sorted(self.cache_dir.glob("*.wav"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in wavs)
        while total > CACHE_CAP_BYTES and wavs:
            victim = wavs.pop(0)
            total -= victim.stat().st_size
            victim.unlink(missing_ok=True)
