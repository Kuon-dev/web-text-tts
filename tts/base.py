"""Engine contract: Voice, EngineUnavailable, the TTSEngine template method."""
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar

import numpy as np

DEVICE_MODES = ("auto", "gpu", "cpu")


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
    default_voice: ClassVar[str]
    sample_rate: int = 24000

    def __init__(self, policy):
        self.policy = policy

    def synthesize(self, text: str, voice: str, urgent: bool = False) -> np.ndarray:
        if not self.is_speakable(text):
            # scene separators ("***", "◆ ◆ ◆") are a narrator pause, not input
            return np.zeros(int(0.4 * self.sample_rate), dtype=np.float32)
        device = self.policy.pick(urgent)
        start = time.monotonic()
        try:
            audio = self._generate(text, voice, device)
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

    @abstractmethod
    def _generate(self, text: str, voice: str, device: str) -> np.ndarray: ...

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
