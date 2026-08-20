"""Qwen3-TTS 0.6B: presets (CustomVoice) + clones (Base), one variant resident.

GPU-only: ~0.2-0.3x realtime on CPU is unusable, so DevicePolicy(allow_cpu=False)
pauses (EngineUnavailable) instead of falling back when the GPU is contended.
Thresholds differ from Kokoro's: anything under QWEN_MIN_SPEED can't keep up
with playback.

The "~1-2x realtime on the 4060" this engine was designed around was never
measured - the 2026-07-23 addendum records the benchmark as DEFERRED, and the
figure came from third-party reports. First hardware measurement (L4, bench
addendum 2026-08-20) puts batch-1 decode at 0.60x, i.e. BELOW QWEN_MIN_SPEED:
serial generation cannot feed playback on real hardware. Batching is what
clears the bar (3.69x at max_batch=8), so the worker hands whole batches to
synthesize_many and the policy judges the batch, not one chunk.
"""
import hashlib
import logging

import numpy as np

from .base import TTSEngine, Voice
from .device import DevicePolicy

log = logging.getLogger("novel-tts")

QWEN_MIN_SPEED = 0.8            # below this the reader outruns generation
# Batch-1 decode is latency-bound: ~140ms per 12Hz frame against a ~6ms
# weight-bandwidth floor, leaving the GPU 99% "utilised" but at half its
# power budget. Widening the batch is nearly free until it is not
# (measured on an L4 2026-08-20: 1 -> 0.62x, 4 -> 2.17x, 8 -> 3.69x,
# 16 -> 3.58x and 9.2GB, 32 -> OOM). 8 is the knee.
QWEN_MAX_BATCH = 8
QWEN_MIN_FREE_BYTES = 2_500_000_000   # 0.6B bf16 weights + KV headroom
_MODELS = {"custom": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
           "base": "Qwen/Qwen3-TTS-12Hz-0.6B-Base"}

# (speaker, group, language-arg) - the 9 documented CustomVoice speakers
PRESETS = [
    ("Ryan", "English male", "English"), ("Aiden", "English male", "English"),
    ("Vivian", "Chinese female", "Chinese"), ("Serena", "Chinese female", "Chinese"),
    ("Uncle_Fu", "Chinese male", "Chinese"), ("Dylan", "Chinese male", "Chinese"),
    ("Eric", "Chinese male", "Chinese"), ("Ono_Anna", "Japanese female", "Japanese"),
    ("Sohee", "Korean female", "Korean"),
]
_PRESET_LANG = {name: lang for name, _, lang in PRESETS}


class Qwen3Engine(TTSEngine):
    id = "qwen3"
    label = "Qwen3-TTS 0.6B"          # must match registry._META
    supported_modes = ("auto", "gpu")
    max_batch = QWEN_MAX_BATCH
    default_voice = "Ryan"
    sample_rate = 24000               # confirmed by scripts/bench_qwen.py

    def __init__(self, mode: str = "auto", clone_store=None):
        import torch
        super().__init__(DevicePolicy(
            allow_cpu=False, min_gpu_speed=QWEN_MIN_SPEED,
            min_free_bytes=QWEN_MIN_FREE_BYTES, mode=mode,
            gpu_available=torch.cuda.is_available(),
            release_gpu=self._release_gpu))
        self._clones = clone_store
        self._instruct = ""
        self._variant = None          # "custom" | "base"
        self._model = None

    def set_instruct(self, text: str) -> None:
        self._instruct = text or ""

    def voices(self) -> list[Voice]:
        out = [Voice(id=n, name=n.replace("_", " "), group=g, language=l)
               for n, g, l in PRESETS]
        if self._clones is not None:
            out += self._clones.voices()
        return out

    def fingerprint(self, voice_id: str) -> str:
        if voice_id.startswith("clone:"):
            return "base-0.6b\x00" + self._clones.fingerprint(voice_id)
        return "custom-0.6b\x00" + hashlib.sha1(self._instruct.encode()).hexdigest()

    def info(self) -> dict:
        return {**super().info(), "cold": self._model is None}

    def _load(self, variant: str):
        if self._variant == variant:
            return self._model
        import torch
        from qwen_tts import Qwen3TTSModel
        self._release_gpu()           # one variant resident at a time (8GB card)
        log.info("loading %s", _MODELS[variant])
        self._model = Qwen3TTSModel.from_pretrained(
            _MODELS[variant], device_map="cuda:0", dtype=torch.bfloat16)
        self._variant = variant
        return self._model

    @staticmethod
    def _variant_for(voice: str) -> str:
        return "base" if voice.startswith("clone:") else "custom"

    def prepare(self, device: str, voice: str) -> None:
        self._load(self._variant_for(voice))

    def _generate_batch(self, texts: list[str], voice: str,
                        device: str) -> list[np.ndarray]:
        if voice.startswith("clone:"):
            # generate_voice_clone takes a single ref clip per call
            return super()._generate_batch(texts, voice, device)
        model = self._load("custom")
        wavs, sr = model.generate_custom_voice(
            text=list(texts), language=_PRESET_LANG.get(voice, "Auto"),
            speaker=voice, instruct=self._instruct or None)
        self.sample_rate = sr
        return [np.asarray(w, dtype=np.float32) for w in wavs]

    def _generate(self, text: str, voice: str, device: str) -> np.ndarray:
        # device is always "cuda" here: policy(allow_cpu=False) never returns cpu
        if voice.startswith("clone:"):
            model = self._load("base")
            wavs, sr = model.generate_voice_clone(          # signature per bench addendum
                text=text, ref_audio=str(self._clones.ref_path(voice)),
                language="Auto")
        else:
            model = self._load("custom")
            wavs, sr = model.generate_custom_voice(
                text=text, language=_PRESET_LANG.get(voice, "Auto"), speaker=voice,
                instruct=self._instruct or None)
        self.sample_rate = sr
        return np.asarray(wavs[0], dtype=np.float32)

    def _release_gpu(self):
        import gc
        self._model = None
        self._variant = None
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def unload(self):
        self._release_gpu()
