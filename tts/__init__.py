"""TTS engines + generate-ahead worker. Import surface for server.py and tests."""
from .base import DEVICE_MODES, EngineUnavailable, TTSEngine, Voice
from .kokoro import (
    GPU_MIN_FREE_BYTES,
    GPU_MIN_SPEED,
    GPU_STALL_SECONDS,
    SAMPLE_RATE,
    KokoroEngine,
)
from .manager import EngineManager
from .worker import (
    CACHE_CAP_BYTES,
    CHARS_PER_SECOND,
    EST_BYTES_PER_CHAR,
    FILL_BUDGET_BYTES,
    FILL_MIN_SPEED,
    FILL_PROBE_S,
    LOOKAHEAD_MAX_CHUNKS,
    LOOKAHEAD_SECONDS,
    MAX_ATTEMPTS,
    TTSWorker,
)
