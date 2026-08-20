"""Current-engine holder. One RLock shared by synthesize and swap gives the
hot-swap handshake for free: a swap waits for the in-flight chunk, and the
next worker pick sees the new engine. Construction is cheap everywhere -
engines lazy-load weights - so swap is synchronous."""
import threading
from pathlib import Path

from .registry import create_engine
from .voices import CloneStore


class EngineManager:
    def __init__(self, data_dir: Path, engine_id: str = "kokoro",
                 mode: str = "auto", factory=create_engine):
        self.clone_store = CloneStore(Path(data_dir) / "voices")
        self._factory = factory
        self._lock = threading.RLock()
        self._engine = factory(engine_id, mode, self.clone_store)

    @property
    def engine_id(self) -> str:
        return self._engine.id

    @property
    def sample_rate(self) -> int:
        return self._engine.sample_rate

    @property
    def max_batch(self) -> int:
        return self._engine.max_batch

    def synthesize(self, text, voice, urgent=False):
        with self._lock:
            return self._engine.synthesize(text, voice, urgent=urgent)

    def synthesize_many(self, texts, voice, urgent=False):
        # One batch holds the swap lock for its whole duration, same as a
        # single synthesize: an engine swap waits for the batch in flight.
        with self._lock:
            return self._engine.synthesize_many(texts, voice, urgent=urgent)

    def swap(self, engine_id: str, mode: str) -> None:
        with self._lock:
            if engine_id == self._engine.id:
                return
            new = self._factory(engine_id, mode, self.clone_store)  # raises if unavailable
            self._engine.unload()
            self._engine = new

    def chunk_namespace(self, voice_id: str) -> str:
        e = self._engine
        return f"{e.id}\x00{e.fingerprint(voice_id)}\x00{voice_id}"

    def voices(self):
        return self._engine.voices()

    def supported_modes(self):
        return self._engine.supported_modes

    def set_mode(self, mode: str) -> None:
        with self._lock:
            self._engine.set_mode(mode)

    def set_instruct(self, text: str) -> None:
        with self._lock:
            self._engine.set_instruct(text)

    def info(self) -> dict:
        return self._engine.info()

    def default_voice(self) -> str:
        return self._engine.default_voice

    def unload(self) -> None:
        with self._lock:
            self._engine.unload()
