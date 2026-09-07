"""Engine contract: Voice, EngineUnavailable, the TTSEngine template method."""
import logging
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar

import numpy as np

log = logging.getLogger("novel-tts")

DEVICE_MODES = ("auto", "gpu", "cpu")
CHARS_PER_SECOND = 15.0  # narration pace measured on real chapters


@dataclass(frozen=True)
class Voice:
    id: str        # "af_heart" | "Ryan" | "clone:3fa9c2d81b04"
    name: str      # display name
    group: str     # combobox group ("US female", "Japanese", "Cloned", ...)
    language: str  # hint passed to engines that want it


class EngineUnavailable(RuntimeError):
    """Cannot synthesize right now (weights loading, GPU contended with no CPU
    fallback). NOT a chunk failure: the worker waits and retries without
    counting an attempt or marking the chunk failed."""


class TTSEngine(ABC):
    id: ClassVar[str]
    label: ClassVar[str]
    supported_modes: ClassVar[tuple[str, ...]] = DEVICE_MODES
    # >1 lets the worker hand several chunks to one model call. Batch-1
    # decode leaves most GPUs idle between tiny kernels; engines that
    # gain from wider batches raise this (see tts/qwen.py).
    max_batch: ClassVar[int] = 1
    default_voice: ClassVar[str]
    sample_rate: int = 24000
    # Runaway guard. An autoregressive engine can fail to emit EOS and keep
    # vocalising: Qwen3 0.6B produced 28s of breathing for a 3s line
    # (spec 2026-09-07). An engine that sets overrun_factor gets a per-text
    # budget of  overrun_factor * len(text) / CHARS_PER_SECOND + overrun_floor_s
    # seconds - the cap it hands its model, and the length past which the
    # base class regenerates the item alone and truncates. None disables it
    # (Kokoro: a fixed-length model never overruns).
    overrun_factor: ClassVar[float | None] = None
    overrun_floor_s: ClassVar[float] = 2.0
    # Retries happen serially under EngineManager._lock, which also gates
    # swap/set_instruct/set_mode and /api/state: five runaways at a 28.7s
    # budget would otherwise be ~4 minutes of UI hang. At most this many
    # over-budget items PER synthesize_many() CALL get a second try; the
    # rest are truncated without regenerating. synthesize() (single) always
    # gets its one retry, independent of this cap.
    max_runaway_retries: ClassVar[int] = 2

    def __init__(self, policy):
        self.policy = policy

    def synthesize(self, text: str, voice: str, urgent: bool = False) -> np.ndarray:
        if not self.is_speakable(text):
            return self._silence()
        device = self.policy.pick(urgent)
        self.prepare(device, voice)
        start = time.monotonic()
        try:
            audio = self._call_generate(text, voice, device)
            audio = self._enforce_budget(text, audio, voice, device, [1])
        except EngineUnavailable:
            raise                      # a gate, not a generation failure
        except Exception as exc:
            if device == "cuda":
                self.policy.failed(str(exc))
            raise
        wall = time.monotonic() - start
        if device == "cuda" and wall >= 1.0 and len(audio) >= 3 * self.sample_rate:
            self.policy.measured((len(audio) / self.sample_rate) / wall)
        return audio

    def prepare(self, device: str, voice: str) -> None:
        """Load whatever `_generate` would otherwise build lazily.

        Called after the device is chosen but BEFORE the clock starts, so a
        one-off model load is never charged to x-realtime. Charging it demoted
        healthy GPUs on their first chunk (a cold Kokoro measured 0.59x on an
        idle L4, against a 1.5x floor), and the demotion dropped the pipeline,
        so every retry paid the load again.
        """

    def budget_seconds(self, text: str) -> float | None:
        """Seconds of audio `text` may produce before it counts as a runaway."""
        if self.overrun_factor is None:
            return None
        return self.overrun_factor * len(text) / CHARS_PER_SECOND + self.overrun_floor_s

    def _silence(self) -> np.ndarray:
        """Scene separators ("***", "◆ ◆ ◆") are a narrator pause, not input."""
        return np.zeros(int(0.4 * self.sample_rate), dtype=np.float32)

    def synthesize_many(self, texts: list[str], voice: str,
                        urgent: bool = False) -> list[np.ndarray]:
        if self.max_batch <= 1:
            return [self.synthesize(t, voice, urgent=urgent) for t in texts]
        out: list[np.ndarray | None] = [None] * len(texts)
        batch = []
        for i, text in enumerate(texts):
            if self.is_speakable(text):
                batch.append((i, text))
            else:
                out[i] = self._silence()
        if not batch:
            return out
        device = self.policy.pick(urgent)
        self.prepare(device, voice)
        start = time.monotonic()
        retries = [self.max_runaway_retries]
        try:
            audio = self._call_generate_batch([t for _, t in batch], voice, device)
            audio = [self._enforce_budget(t, a, voice, device, retries)
                     for (_, t), a in zip(batch, audio)]
        except EngineUnavailable:
            raise                      # a gate, not a generation failure
        except Exception as exc:
            if device == "cuda":
                self.policy.failed(str(exc))
            raise
        wall = time.monotonic() - start
        for (i, _), a in zip(batch, audio):
            out[i] = a
        samples = sum(len(a) for a in audio)
        # same guards as synthesize(), on the batch as a whole: a wide batch is
        # the throughput the worker actually gets, so that is what the policy
        # judges the GPU on.
        if device == "cuda" and wall >= 1.0 and samples >= 3 * self.sample_rate:
            self.policy.measured((samples / self.sample_rate) / wall)
        return out

    def _generate_batch(self, texts: list[str], voice: str, device: str,
                        *, max_seconds: float | None = None) -> list[np.ndarray]:
        return [self._call_generate(t, voice, device) for t in texts]

    def _call_generate(self, text, voice, device):
        budget = self.budget_seconds(text)
        if budget is None:
            return self._generate(text, voice, device)
        return self._generate(text, voice, device, max_seconds=budget)

    def _call_generate_batch(self, texts, voice, device):
        if self.overrun_factor is None:
            return self._generate_batch(texts, voice, device)
        return self._generate_batch(
            texts, voice, device,
            max_seconds=max(self.budget_seconds(t) for t in texts))

    def _enforce_budget(self, text, audio, voice, device, retries):
        """Over budget = the engine hit its cap without an EOS. Try once more
        alone (sampling is stochastic; the second take is usually fine), and
        keep whatever comes back, cut at the budget: at that point the audio
        is already breathing, and a fade would only lengthen it.

        `retries` is a mutable one-element counter shared across every item
        in the same synthesize_many() call: each retry runs serially under
        EngineManager._lock, so once it is spent the remaining over-budget
        items are truncated in place, without regenerating."""
        budget = self.budget_seconds(text)
        if budget is None:
            return audio
        limit = int(budget * self.sample_rate)
        if len(audio) <= limit:
            return audio
        if retries[0] <= 0:
            log.warning("runaway: %.1fs of audio for %d chars (budget %.1fs), "
                        "retry budget spent, truncating",
                        len(audio) / self.sample_rate, len(text), budget)
            return audio[:limit]
        retries[0] -= 1
        log.warning("runaway: %.1fs of audio for %d chars (budget %.1fs), regenerating alone",
                    len(audio) / self.sample_rate, len(text), budget)
        audio = self._generate(text, voice, device, max_seconds=budget)
        return audio[:limit]

    @abstractmethod
    def _generate(self, text: str, voice: str, device: str, *,
                  max_seconds: float | None = None) -> np.ndarray:
        """An engine that sets `overrun_factor` must accept this keyword;
        unbudgeted engines are never passed it."""

    @abstractmethod
    def voices(self) -> list[Voice]: ...

    @abstractmethod
    def fingerprint(self, voice_id: str) -> str:
        """Cache-key contribution: anything that changes audio for the same
        (voice, text) — pronunciation rules, model variant, instruct, ref clip."""

    def is_speakable(self, text: str) -> bool:
        return re.search(r"\w", text) is not None  # \w matches CJK

    def set_instruct(self, text: str) -> None:
        """Global style instruction; engines that support it override."""

    def set_mode(self, mode: str) -> None:
        self.policy.set_mode(mode)

    def info(self) -> dict:
        return {"engine": self.id, "label": self.label, "cold": False,
                **self.policy.info()}

    def unload(self) -> None:
        """Drop model refs / free VRAM before an engine swap."""
