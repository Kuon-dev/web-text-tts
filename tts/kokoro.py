"""Kokoro engine: lazy per-(language, device) pipeline with GPU->CPU failover."""
import logging
import re
import time

import numpy as np

from .base import TTSEngine, Voice
from .device import DevicePolicy

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
GPU_MIN_SPEED = 1.5
GPU_STALL_SECONDS = 45.0
GPU_MIN_FREE_BYTES = 1_500_000_000  # start on CPU if a game already holds VRAM

VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova",
    "am_adam", "am_michael", "am_fenrir", "am_puck",
    "bf_emma", "bf_isabella", "bf_lily",
    "bm_george", "bm_lewis", "bm_fable",
]

PRONUNCIATION_V = "2"   # moved from chunker.py; bump when pronunciation rules change

_GROUPS = {"af": ("US female", "en-US"), "am": ("US male", "en-US"),
           "bf": ("UK female", "en-GB"), "bm": ("UK male", "en-GB")}


class KokoroEngine(TTSEngine):
    """Lazy per-(language, device) KPipeline wrapper; policy handles failover."""

    id = "kokoro"
    label = "Kokoro-82M"
    default_voice = "af_heart"
    sample_rate = SAMPLE_RATE

    def __init__(self, mode: str = "auto"):
        import torch
        gpu = torch.cuda.is_available()
        # Before super(): DevicePolicy's constructor calls set_mode, and
        # set_mode("cpu") invokes release_gpu (device.py) - so this callback
        # can fire while we are still inside __init__. Whatever it touches
        # has to exist by then. An earlier comment here claimed pinned modes
        # never reach it; they do, and a persisted device_mode of "cpu"
        # crashed the server on startup.
        self._pipelines = {}
        super().__init__(DevicePolicy(
            allow_cpu=True, min_gpu_speed=GPU_MIN_SPEED,
            min_free_bytes=GPU_MIN_FREE_BYTES, mode=mode, gpu_available=gpu,
            release_gpu=self._release_gpu,
        ))
        log.info("Kokoro gpu_available=%s mode=%s", gpu, self.policy.mode)

    def voices(self):
        out = []
        for vid in VOICES:
            group, lang = _GROUPS[vid[:2]]
            out.append(Voice(id=vid, name=vid[3:].capitalize(), group=group, language=lang))
        return out

    def fingerprint(self, voice_id):
        return PRONUNCIATION_V

    def is_speakable(self, text):
        # kanji/kana would be espeak-mangled by the a/b voices; keep silencing
        return re.search(r"[A-Za-z0-9]", text) is not None

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

    def prepare(self, device, voice):
        self._pipeline(voice, device)

    def _generate(self, text, voice, device):
        import torch
        start = time.monotonic()
        pieces = []
        for result in self._pipeline(voice, device)(text, voice=voice):
            audio = getattr(result, "audio", None)
            if audio is None and isinstance(result, tuple):
                audio = result[2]
            if audio is not None:
                pieces.append(audio if isinstance(audio, torch.Tensor) else torch.as_tensor(audio))
            if (device == "cuda" and self.policy.mode == "auto"
                    and time.monotonic() - start > GPU_STALL_SECONDS):
                raise RuntimeError(f"stalled mid-chunk (>{GPU_STALL_SECONDS:.0f}s)")
        if not pieces:
            raise RuntimeError(f"Kokoro produced no audio for: {text[:60]!r}")
        return torch.cat(pieces).cpu().numpy().astype(np.float32)

    def _release_gpu(self):
        import gc
        import torch
        if any(k[1] == "cuda" for k in self._pipelines):
            self._pipelines = {k: p for k, p in self._pipelines.items() if k[1] != "cuda"}
            gc.collect()  # drop the CUDA model tensors before freeing the cache
        if torch.cuda.is_initialized():
            torch.cuda.empty_cache()  # hand the VRAM back to the game

    def unload(self):
        self._pipelines = {}
        self._release_gpu()
