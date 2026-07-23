"""Qwen3-TTS 0.6B: presets (CustomVoice) + clones (Base), one variant resident.

GPU-only: ~0.2-0.3x realtime on CPU is unusable, so DevicePolicy(allow_cpu=False)
pauses (EngineUnavailable) instead of falling back when the GPU is contended.
Thresholds differ from Kokoro's: at ~1-2x realtime on the 4060 (bench 2026-07-23,
see spec addendum), anything under QWEN_MIN_SPEED can't keep up with playback.
"""
import hashlib
import logging

import numpy as np

from .base import TTSEngine, Voice
from .device import DevicePolicy

log = logging.getLogger("novel-tts")

QWEN_MIN_SPEED = 0.8            # below this the reader outruns generation
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
