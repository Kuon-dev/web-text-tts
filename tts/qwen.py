"""Qwen3-TTS 1.7B: presets (CustomVoice) + clones (Base), one variant resident.

Moved from the 0.6B models on 2026-09-08: on the L4 the 1.7B decodes at the
same speed (0.61x vs 0.60x at batch 1, 9.5x vs 8.0x at batch 32 - decode is
per-step-overhead bound, not weight bound), its takes are tighter, and unlike
the 0.6B it honours the instruct field, so a "calm narration" instruction can
steer the sighs and laughs out. Cost: 3.9GB of weights instead of 2.0GB and a
44s instead of 22s cold load.

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

Generation length is also unbounded by default: the model can miss EOS and
breathe for a minute. Every call is capped at the base class's text budget
(QWEN_OVERRUN_FACTOR), which is what bounds the decoder's padded batch too.
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
# power budget. Widening the batch buys throughput almost linearly, and the
# wall time of one batch barely moves with its width (17s at 8, 34s at 48),
# so a wider batch costs little extra latency for a seek waiting it out.
#
# Measured on an idle L4 (2026-08-21): 8 -> 3.66x/3.6GB, 16 -> 3.94x/9.1GB,
# 24 -> 7.74x/8.9GB, 32 -> 8.90x/12.3GB, 48 -> 11.72x/17.0GB. 32 is chosen
# over the faster 48 for headroom: those figures are for ~8s chunks, and a
# batch of long ones needs more VRAM than 17 of 22.5GB leaves room for.
#
# Caveat for anyone re-tuning this: generation length is stochastic, and a
# batch runs until its LONGEST member finishes, so single-shot numbers are
# noisy (the 16 vs 24 inversion above is that noise). Average repeats, and
# measure with nothing else holding the GPU - an earlier sweep taken while
# the server was generating showed a false knee at 8 and a false OOM at 32.
QWEN_MAX_BATCH = 32
QWEN_MIN_FREE_BYTES = 4_500_000_000   # 1.7B bf16 weights (3.9GB) + KV headroom
# Runaway guard (spec 2026-09-07). The 0.6B model sometimes never emitted EOS
# on breathy or emotive text: "Haa... haa... I can't... breathe..." (44 chars,
# ~3s) came back as 28.4s of continuous breathing at batch 1, and the cache
# held 124 WAVs over 17s for chunks capped at 250 chars. The library's only
# length control is max_new_tokens per call (default 2048 frames = 164s), so
# every call gets the budget the base class derives from the text, in codec
# frames. This also bounds the codec decoder, which pads a whole batch to its
# longest member: a 68s runaway in a 32-wide batch made it OOM on 3.09 GiB.
# The 1.7B misses EOS less often (68 benchmark takes of the lines that tripped
# the 0.6B: one 0.3s overrun, no 13s+ take), but the guard stays as insurance.
QWEN_FRAMES_PER_SECOND = 12.5     # 12Hz tokenizer family: 12.5 frames/s per model card
QWEN_OVERRUN_FACTOR = 1.6         # 1.6x the 15 chars/s estimate + the 2s floor
_MODELS = {"custom": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
           "base": "Qwen/Qwen3-TTS-12Hz-1.7B-Base"}

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
    label = "Qwen3-TTS 1.7B"          # must match registry._META
    supported_modes = ("auto", "gpu")
    max_batch = QWEN_MAX_BATCH
    overrun_factor = QWEN_OVERRUN_FACTOR
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
            return "base-1.7b\x00" + self._clones.fingerprint(voice_id)
        return "custom-1.7b\x00" + hashlib.sha1(self._instruct.encode()).hexdigest()

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

    @staticmethod
    def _cap(max_seconds: float | None) -> int | None:
        # +1 so a generation that hits the cap is longer than its budget and
        # the base class sees it as a runaway; a natural stop never exceeds it.
        if max_seconds is None:
            return None
        return int(max_seconds * QWEN_FRAMES_PER_SECOND) + 1

    def prepare(self, device: str, voice: str) -> None:
        self._load(self._variant_for(voice))

    def _generate_batch(self, texts: list[str], voice: str, device: str,
                        *, max_seconds: float | None = None) -> list[np.ndarray]:
        if voice.startswith("clone:"):
            # generate_voice_clone takes a single ref clip per call; the base
            # implementation hands each item its own budget via _call_generate,
            # so max_seconds here would be inert
            return super()._generate_batch(texts, voice, device)
        model = self._load("custom")
        wavs, sr = model.generate_custom_voice(
            text=list(texts), language=_PRESET_LANG.get(voice, "Auto"),
            speaker=voice, instruct=self._instruct or None,
            max_new_tokens=self._cap(max_seconds))
        self.sample_rate = sr
        return [np.asarray(w, dtype=np.float32) for w in wavs]

    def _generate(self, text: str, voice: str, device: str,
                  *, max_seconds: float | None = None) -> np.ndarray:
        # device is always "cuda" here: policy(allow_cpu=False) never returns cpu
        if voice.startswith("clone:"):
            model = self._load("base")
            wavs, sr = model.generate_voice_clone(          # signature per bench addendum
                text=text, ref_audio=str(self._clones.ref_path(voice)),
                language="Auto", max_new_tokens=self._cap(max_seconds))
        else:
            model = self._load("custom")
            wavs, sr = model.generate_custom_voice(
                text=text, language=_PRESET_LANG.get(voice, "Auto"), speaker=voice,
                instruct=self._instruct or None, max_new_tokens=self._cap(max_seconds))
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
