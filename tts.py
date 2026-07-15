"""Kokoro engine + background generate-ahead worker writing WAVs to a hash cache."""
import logging
import re
import threading
import time
from itertools import chain
from pathlib import Path

import numpy as np
import soundfile as sf

from chunker import Chunk, chunk_id

log = logging.getLogger("novel-tts")

SAMPLE_RATE = 24000
CACHE_CAP_BYTES = 2 * 1024 ** 3
# Under game GPU contention the 4060 can tip into VRAM paging, where
# generation collapses from ~10x realtime to ~0.01x (measured 2026-07-15:
# one chunk per 10-30 minutes while a game held 6.9GB of 8GB). The CPU does
# a steady ~2x realtime (measured on the 5700X), so the engine watches its
# own speed and fails over: a GPU chunk that measures below GPU_MIN_SPEED,
# errors, or trips the mid-chunk stall watchdog sends later work to a CPU
# pipeline and returns torch's cached VRAM to the game. The GPU is re-tried
# on chunks nobody is waiting for, with exponential backoff — and only once
# mem_get_info shows the game has released VRAM: the stall watchdog only
# runs between Kokoro output segments, and most chunks yield exactly one,
# so a probe landing on a paging GPU blocks the whole worker for the length
# of the forward pass (measured 7+ minutes with a game holding 7.2/8GB),
# freezing playback behind it. While VRAM stays scarce the probe is
# re-checked every GPU_VRAM_POLL_S instead of running.
#
# That failover is the "auto" mode. The user can also pin the engine: "gpu"
# always uses CUDA (no failover, no watchdog — the user chose it), "cpu"
# never touches the GPU at all, leaving every byte of VRAM to the game.
ENGINE_MODES = ("auto", "gpu", "cpu")
GPU_MIN_SPEED = 1.5
GPU_STALL_SECONDS = 45.0
GPU_RETRY_S = 600.0
GPU_RETRY_MAX_S = 3600.0
GPU_VRAM_POLL_S = 30.0
GPU_MIN_FREE_BYTES = 1_500_000_000  # start on CPU if a game already holds VRAM

# Soon-needed window: chunks playback will reach in the next few minutes are
# generated regardless of contention. Beyond it the worker back-fills the
# whole document (position -> end, then wrap-around to cover rewinds), but
# only while measured speed shows a free GPU: a worker busy on a far chunk
# delays urgent jumps by a whole in-flight generation and fights the game
# for the GPU. While slow, one probe chunk per FILL_PROBE_S keeps the speed
# reading fresh. The byte budget stops the fill just short of the cache cap
# so a pathological paste can never evict-and-regenerate its own audio.
CHARS_PER_SECOND = 15.0  # narration pace measured on real chapters
LOOKAHEAD_SECONDS = 180.0
LOOKAHEAD_MAX_CHUNKS = 64
EST_BYTES_PER_CHAR = SAMPLE_RATE * 2 / CHARS_PER_SECOND  # PCM16 mono WAV
FILL_BUDGET_BYTES = CACHE_CAP_BYTES * 0.9
FILL_MIN_SPEED = 4.0
FILL_PROBE_S = 90.0
MAX_ATTEMPTS = 2

VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova",
    "am_adam", "am_michael", "am_fenrir", "am_puck",
    "bf_emma", "bf_isabella", "bf_lily",
    "bm_george", "bm_lewis", "bm_fable",
]


class KokoroEngine:
    """Lazy per-(language, device) KPipeline wrapper with GPU->CPU failover."""

    def __init__(self, mode: str = "auto"):
        import torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._mode = mode if mode in ENGINE_MODES else "auto"
        log.info("Kokoro device: %s (mode: %s)", self.device, self._mode)
        self._pipelines = {}
        self._gpu_ok = True
        self._gpu_dirty = False
        self._gpu_retry_at = 0.0
        self._gpu_retry_wait = GPU_RETRY_S
        if self.device == "cuda" and self._mode == "auto":
            # mem_get_info creates a CUDA context (~300MB VRAM), so pinned
            # modes skip it: "cpu" must not take VRAM, "gpu" ignores it.
            free, _total = torch.cuda.mem_get_info()
            if free < GPU_MIN_FREE_BYTES:
                log.warning("GPU has only %dMB free — starting on CPU", free // 2**20)
                self._gpu_ok = False
                self._gpu_retry_at = time.monotonic() + GPU_RETRY_S

    def _pipeline(self, voice: str, device: str):
        key = (voice[0], device)
        if key not in self._pipelines:
            from kokoro import KPipeline
            self._pipelines[key] = KPipeline(lang_code=voice[0], device=device)
        return self._pipelines[key]

    def set_mode(self, mode: str) -> None:
        if mode not in ENGINE_MODES:
            raise ValueError(f"unknown engine mode: {mode}")
        if mode == self._mode:
            return
        self._mode = mode
        log.info("engine mode -> %s", mode)
        if mode == "cpu":
            self._release_gpu()
            # an in-flight GPU chunk still holds model refs; release again
            # once it finishes so all the VRAM actually goes back to the game
            self._gpu_dirty = True
        else:
            self._gpu_ok = True  # fresh optimism; auto re-measures on the next chunk
            self._gpu_retry_wait = GPU_RETRY_S

    def info(self) -> dict:
        gpu = self.device == "cuda"
        on_gpu = gpu and self._mode != "cpu" and (self._mode == "gpu" or self._gpu_ok)
        return {"mode": self._mode, "active": "gpu" if on_gpu else "cpu",
                "gpu_available": gpu}

    def _release_gpu(self):
        import gc
        import torch
        if any(k[1] == "cuda" for k in self._pipelines):
            self._pipelines = {k: p for k, p in self._pipelines.items() if k[1] != "cuda"}
            gc.collect()  # drop the CUDA model tensors before freeing the cache
        if torch.cuda.is_initialized():
            torch.cuda.empty_cache()  # hand the VRAM back to the game

    def _pick_device(self, urgent: bool) -> str:
        if self.device != "cuda" or self._mode == "cpu":
            return "cpu"
        if self._mode == "gpu" or self._gpu_ok:
            return "cuda"
        if not urgent and time.monotonic() >= self._gpu_retry_at:
            if self._gpu_probe_allowed():
                return "cuda"  # probe on a chunk nobody is waiting for
            self._gpu_retry_at = time.monotonic() + GPU_VRAM_POLL_S
        return "cpu"

    def _gpu_probe_allowed(self) -> bool:
        import torch
        try:
            free, _total = torch.cuda.mem_get_info()
        except Exception:
            return False  # driver unhappy — a real probe would fare no better
        if free >= GPU_MIN_FREE_BYTES:
            self._vram_wait_logged = False
            return True
        if not getattr(self, "_vram_wait_logged", False):
            # one line per contention episode, not one per 30s poll
            self._vram_wait_logged = True
            log.info("GPU has only %dMB free — waiting for VRAM before re-trying GPU",
                     free // 2**20)
        return False

    def _gpu_failed(self, reason: str):
        import torch
        level = log.warning if self._gpu_ok else log.info
        level("GPU %s — using CPU (next GPU try in %.0fs)", reason, self._gpu_retry_wait)
        self._gpu_ok = False
        self._gpu_retry_at = time.monotonic() + self._gpu_retry_wait
        self._gpu_retry_wait = min(self._gpu_retry_wait * 2, GPU_RETRY_MAX_S)
        if torch.cuda.is_initialized():
            torch.cuda.empty_cache()  # hand cached VRAM back to the game

    def _gpu_measured(self, speed: float):
        if speed < GPU_MIN_SPEED:
            self._gpu_failed(f"at {speed:.2f}x realtime (contended)")
        elif not self._gpu_ok:
            log.info("GPU recovered (%.1fx realtime) — back to CUDA", speed)
            self._gpu_ok = True
            self._gpu_retry_wait = GPU_RETRY_S

    def synthesize(self, text: str, voice: str, urgent: bool = False) -> np.ndarray:
        if not re.search(r"[A-Za-z0-9]", text):
            # scene separators ("***", "* * *", "◆ ◆ ◆") have no speakable
            # content and make Kokoro raise; treat them as a narrator pause.
            return np.zeros(int(0.4 * SAMPLE_RATE), dtype=np.float32)
        import torch
        device = self._pick_device(urgent)
        if device == "cpu" and getattr(self, "_gpu_dirty", False):
            self._gpu_dirty = False
            self._release_gpu()
        start = time.monotonic()
        pieces = []
        try:
            for result in self._pipeline(voice, device)(text, voice=voice):
                audio = getattr(result, "audio", None)
                if audio is None and isinstance(result, tuple):
                    audio = result[2]
                if audio is not None:
                    pieces.append(audio if isinstance(audio, torch.Tensor) else torch.as_tensor(audio))
                if (device == "cuda" and self._mode == "auto"
                        and time.monotonic() - start > GPU_STALL_SECONDS):
                    raise RuntimeError(f"stalled mid-chunk (>{GPU_STALL_SECONDS:.0f}s)")
        except Exception as exc:
            if device == "cuda" and self._mode == "auto":
                self._gpu_failed(str(exc))
            raise
        if not pieces:
            raise RuntimeError(f"Kokoro produced no audio for: {text[:60]!r}")
        out = torch.cat(pieces).cpu().numpy().astype(np.float32)
        if device == "cuda" and self._mode == "auto":
            wall = time.monotonic() - start
            if wall >= 1.0 and len(out) >= 3 * SAMPLE_RATE:
                self._gpu_measured((len(out) / SAMPLE_RATE) / wall)
        return out


class TTSWorker:
    def __init__(self, cache_dir: Path, engine,
                 fill_min_speed: float = FILL_MIN_SPEED,
                 fill_probe_interval: float = FILL_PROBE_S):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._engine = engine
        self._fill_min_speed = fill_min_speed
        self._fill_probe_interval = fill_probe_interval
        self._speed = 0.0  # last measured generation speed, x realtime
        self._last_fill_probe = time.monotonic() - fill_probe_interval
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

    @property
    def speed(self) -> float:
        """Last measured generation speed, x realtime (0 until first chunk)."""
        return self._speed

    def status(self) -> dict:
        with self._cond:
            cids, failed = list(self._cids), set(self._failed)
        ready, durations = [], {}
        for c in cids:
            try:
                size = self.path(c).stat().st_size
            except OSError:
                continue
            ready.append(c)
            # PCM_16 mono @ 24kHz behind a 44-byte WAV header
            durations[c] = max(0, size - 44) / 48000.0
        return {
            "ready": ready,
            "failed": [c for c in cids if c in failed],
            "durations": durations,
        }

    # -- worker loop ---------------------------------------------------------
    def _pick(self):
        """Under lock: (cid, text, urgent) to generate next, or None."""
        by_id = dict(zip(self._cids, (c.text for c in self._chunks)))
        for cid in self._requests:
            if (cid in by_id and not self.path(cid).exists()
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, by_id[cid], True
        self._requests = [c for c in self._requests
                          if c in by_id and not self.path(c).exists()
                          and self._attempts.get(c, 0) < MAX_ATTEMPTS]
        end, seconds = self._position, 0.0
        while (end < len(self._cids)
               and end - self._position < LOOKAHEAD_MAX_CHUNKS
               and seconds < LOOKAHEAD_SECONDS):
            seconds += len(self._chunks[end].text) / CHARS_PER_SECOND
            end += 1
        for idx in range(self._position, end):
            cid = self._cids[idx]
            if (not self.path(cid).exists() and cid not in self._failed
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, self._chunks[idx].text, False
        probing = self._speed < self._fill_min_speed
        if probing:
            now = time.monotonic()
            if now - self._last_fill_probe < self._fill_probe_interval:
                return None
        spent = 0.0
        for idx in chain(range(self._position, len(self._cids)),
                         range(0, self._position)):
            spent += len(self._chunks[idx].text) * EST_BYTES_PER_CHAR
            if spent > FILL_BUDGET_BYTES:
                break
            cid = self._cids[idx]
            if (not self.path(cid).exists() and cid not in self._failed
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                if probing:
                    self._last_fill_probe = now
                return cid, self._chunks[idx].text, False
        return None

    def _run(self):
        while True:
            with self._cond:
                job = self._pick()
                if job is None:
                    self._cond.wait(timeout=1.0)
                    continue
                cid, text, urgent = job
                voice = self._voice
                self._attempts[cid] = self._attempts.get(cid, 0) + 1
            try:
                start = time.monotonic()
                audio = self._engine.synthesize(text, voice, urgent=urgent)
                wall = time.monotonic() - start
                tmp = self.path(cid).with_suffix(".tmp")
                sf.write(tmp, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
                tmp.rename(self.path(cid))
                self._enforce_cache_cap()
                with self._cond:
                    if wall >= 0.3 and len(audio) >= SAMPLE_RATE:
                        self._speed = (len(audio) / SAMPLE_RATE) / wall
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
