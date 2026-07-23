"""Kokoro engine: lazy per-(language, device) pipeline with GPU->CPU failover."""
import logging
import re
import time

import numpy as np

log = logging.getLogger("novel-tts")

SAMPLE_RATE = 24000
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

            from romaji import RomajiFallback
            pipe = KPipeline(lang_code=voice[0], device=device)
            # dictionary-miss words that look like romaji (character names
            # in translated JP novels) get rule-based phonemes instead of
            # espeak guessing with English spelling rules ("Touka"->"TOW-ka")
            if hasattr(pipe.g2p, "fallback"):
                pipe.g2p.fallback = RomajiFallback(pipe.g2p.fallback)
            self._pipelines[key] = pipe
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
