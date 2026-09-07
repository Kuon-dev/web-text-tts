import pytest

from tts import registry
from tts.registry import ENGINE_IDS, create_engine, engine_catalog


def test_catalog_lists_both_engines_with_modes():
    cat = {e["id"]: e for e in engine_catalog()}
    assert set(cat) == set(ENGINE_IDS) == {"kokoro", "qwen3"}
    assert cat["kokoro"]["available"] is True
    assert cat["kokoro"]["supported_modes"] == ["auto", "gpu", "cpu"]
    assert cat["qwen3"]["supported_modes"] == ["auto", "gpu"]
    assert cat["qwen3"]["label"] == "Qwen3-TTS 1.7B"


def test_qwen_unavailable_without_package(monkeypatch):
    monkeypatch.setattr(registry, "_qwen_installed", lambda: False)
    cat = {e["id"]: e for e in engine_catalog()}
    assert cat["qwen3"]["available"] is False
    assert "qwen-tts" in cat["qwen3"]["reason"]
    with pytest.raises(ValueError, match="qwen-tts"):
        create_engine("qwen3", "auto")


def test_create_engine_rejects_unknown_id():
    with pytest.raises(ValueError, match="unknown engine"):
        create_engine("espeak", "auto")


def test_voice_ids_static_lookup():
    from tts.registry import voice_ids
    assert "af_heart" in voice_ids("kokoro")
    assert "Ryan" in voice_ids("qwen3")
    assert len(voice_ids("kokoro")) == 16 and len(voice_ids("qwen3")) == 9
