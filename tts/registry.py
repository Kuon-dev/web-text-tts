"""Engine discovery. Heavy imports stay inside create_engine so the catalog
(and the fast test suite) never needs torch or qwen-tts installed."""
import importlib.util

ENGINE_IDS = ("kokoro", "qwen3")

_META = {
    "kokoro": {"label": "Kokoro-82M", "supported_modes": ["auto", "gpu", "cpu"]},
    "qwen3": {"label": "Qwen3-TTS 0.6B", "supported_modes": ["auto", "gpu"]},
}


def _qwen_installed() -> bool:
    return importlib.util.find_spec("qwen_tts") is not None


def _availability(engine_id: str) -> str | None:
    """None if usable, else the human-readable reason."""
    if engine_id == "qwen3" and not _qwen_installed():
        return "qwen-tts is not installed (pip install qwen-tts)"
    return None


def engine_catalog() -> list[dict]:
    out = []
    for eid in ENGINE_IDS:
        reason = _availability(eid)
        out.append({"id": eid, **_META[eid],
                    "available": reason is None, "reason": reason})
    return out


def voice_ids(engine_id: str, clone_store=None) -> set[str]:
    """Voice ids an engine would offer, without constructing it."""
    if engine_id == "kokoro":
        from .kokoro import VOICES
        return set(VOICES)
    from .qwen import PRESETS
    out = {name for name, _, _ in PRESETS}
    if clone_store is not None:
        out |= {v.id for v in clone_store.voices()}
    return out


def create_engine(engine_id: str, mode: str, clone_store=None):
    if engine_id not in ENGINE_IDS:
        raise ValueError(f"unknown engine: {engine_id}")
    reason = _availability(engine_id)
    if reason is not None:
        raise ValueError(reason)
    if engine_id == "kokoro":
        from .kokoro import KokoroEngine
        return KokoroEngine(mode=mode)
    from .qwen import Qwen3Engine
    return Qwen3Engine(mode=mode, clone_store=clone_store)
