import sys
import types

import numpy as np
import pytest


@pytest.fixture()
def fake_qwen(monkeypatch):
    calls = {"loaded": [], "custom": [], "clone": []}

    class FakeModel:
        @classmethod
        def from_pretrained(cls, name, **kw):
            calls["loaded"].append(name)
            return cls()

        def generate_custom_voice(self, *, text, language, speaker, instruct=None):
            calls["custom"].append((text, language, speaker, instruct))
            return [np.zeros(24000, dtype=np.float32)], 24000

        def generate_voice_clone(self, *, text, ref_audio, language):
            calls["clone"].append((text, ref_audio, language))
            return [np.zeros(24000, dtype=np.float32)], 24000

    mod = types.ModuleType("qwen_tts")
    mod.Qwen3TTSModel = FakeModel
    monkeypatch.setitem(sys.modules, "qwen_tts", mod)
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(
        bfloat16="bf16", cuda=types.SimpleNamespace(
            is_available=lambda: True, empty_cache=lambda: None,
            mem_get_info=lambda: (8 * 2**30, 8 * 2**30))))
    return calls


def make_engine(fake_qwen, tmp_path):
    from tts.qwen import Qwen3Engine
    from tts.voices import CloneStore
    return Qwen3Engine(mode="gpu", clone_store=CloneStore(tmp_path))


def test_identity(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    assert (e.id, e.label) == ("qwen3", "Qwen3-TTS 0.6B")
    assert e.supported_modes == ("auto", "gpu")
    assert e.default_voice == "Ryan"
    assert e.info()["cold"] is True                      # nothing loaded yet


def test_preset_synthesis_loads_custom_variant_once(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    e.set_instruct("read it calmly")
    e.synthesize("Hello there, traveler.", "Ryan")
    e.synthesize("Another line.", "Ryan")
    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"]
    assert fake_qwen["custom"][0] == ("Hello there, traveler.", "English", "Ryan", "read it calmly")
    assert e.info()["cold"] is False


def test_clone_synthesis_swaps_to_base_variant(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")
    e.synthesize("Hello.", "Ryan")
    e.synthesize("Cloned line.", voice.id)
    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                                   "Qwen/Qwen3-TTS-12Hz-0.6B-Base"]
    assert fake_qwen["clone"][0][1].endswith("ref.wav")


def test_fingerprints(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    base = e.fingerprint("Ryan")
    e.set_instruct("whisper")
    assert e.fingerprint("Ryan") != base                 # instruct changes preset cids
    voice = e._clones.add(tv.clip_bytes(), name="A")
    fp = e.fingerprint(voice.id)
    assert fp.startswith("base-0.6b") and "whisper" not in fp   # clones ignore instruct


def test_speakable_accepts_japanese(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    assert e.is_speakable("彼女は頷いた。")               # the whole point
    assert not e.is_speakable("◆ ◆ ◆")


def test_voices_are_presets_plus_clones(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    e._clones.add(tv.clip_bytes(), name="Narrator A")
    voices = e.voices()
    ids = [v.id for v in voices]
    assert "Ryan" in ids and "Ono_Anna" in ids and len(ids) == 10
    assert voices[-1].group == "Cloned"
