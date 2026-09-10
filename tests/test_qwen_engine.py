import sys
import types

import numpy as np
import pytest


@pytest.fixture()
def fake_qwen(monkeypatch):
    calls = {"loaded": [], "custom": [], "clone": [], "caps": [], "sampling": []}

    class FakeModel:
        @classmethod
        def from_pretrained(cls, name, **kw):
            calls["loaded"].append(name)
            return cls()

        def generate_custom_voice(self, *, text, language, speaker, instruct=None,
                                  max_new_tokens=None, **kw):
            calls["custom"].append((text, language, speaker, instruct))
            calls["caps"].append(max_new_tokens)
            calls["sampling"].append(kw)
            n = len(text) if isinstance(text, list) else 1
            return [np.zeros(24000, dtype=np.float32) for _ in range(n)], 24000

        def generate_voice_clone(self, *, text, ref_audio, language,
                                 max_new_tokens=None, **kw):
            calls["clone"].append((text, ref_audio, language))
            calls["caps"].append(max_new_tokens)
            calls["sampling"].append(kw)
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
    assert (e.id, e.label) == ("qwen3", "Qwen3-TTS 1.7B")
    assert e.supported_modes == ("auto", "gpu")
    assert e.default_voice == "Ryan"
    assert e.info()["loading"] is False                   # idle, not loading


def test_preset_synthesis_loads_custom_variant_once(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    e.set_instruct("read it calmly")
    e.synthesize("Hello there, traveler.", "Ryan")
    e.synthesize("Another line.", "Ryan")
    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"]
    assert fake_qwen["custom"][0] == ("Hello there, traveler.", "English", "Ryan", "read it calmly")
    assert e.info()["loading"] is False


def test_clone_synthesis_swaps_to_base_variant(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")
    e.synthesize("Hello.", "Ryan")
    e.synthesize("Cloned line.", voice.id)
    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
                                   "Qwen/Qwen3-TTS-12Hz-1.7B-Base"]
    assert fake_qwen["clone"][0][1].endswith("ref.wav")


def test_fingerprints(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    base = e.fingerprint("Ryan")
    e.set_instruct("whisper")
    assert e.fingerprint("Ryan") != base                 # instruct changes preset cids
    voice = e._clones.add(tv.clip_bytes(), name="A")
    fp = e.fingerprint(voice.id)
    assert fp.startswith("base-1.7b") and "whisper" not in fp   # clones ignore instruct


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


def test_qwen_declares_a_batch_width(fake_qwen, tmp_path):
    assert make_engine(fake_qwen, tmp_path).max_batch == 32


def test_preset_batch_reaches_the_model_as_a_single_call(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)

    out = e.synthesize_many(["one.", "two.", "three."], "Ryan")

    assert len(out) == 3
    assert len(fake_qwen["custom"]) == 1                     # not three calls
    assert fake_qwen["custom"][0][0] == ["one.", "two.", "three."]


def test_clone_voices_fall_back_to_one_call_each(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")

    out = e.synthesize_many(["one.", "two."], voice.id)

    assert len(out) == 2
    assert len(fake_qwen["clone"]) == 2      # clone API takes one ref clip at a time


def test_prepare_loads_the_variant_before_the_clock_starts(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)

    e.prepare("cuda", "Ryan")

    assert fake_qwen["loaded"] == ["Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"]
    assert e.info()["loading"] is False


def test_qwen_declares_a_budget_and_cap():
    from tts.qwen import QWEN_FRAMES_PER_SECOND, QWEN_OVERRUN_FACTOR, Qwen3Engine
    assert (QWEN_FRAMES_PER_SECOND, QWEN_OVERRUN_FACTOR) == (12.5, 1.6)
    assert Qwen3Engine.overrun_factor == 1.6
    assert Qwen3Engine._cap(None) is None
    # +1 so a capped generation is strictly longer than its budget
    assert Qwen3Engine._cap(18.0) == 226


def test_preset_call_is_capped_at_the_budget_in_codec_frames(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)
    text = "x" * 150                       # 10s at 15 chars/s -> 1.6x + 2s = 18s

    e.synthesize(text, "Ryan")

    assert e.budget_seconds(text) == pytest.approx(18.0)
    assert fake_qwen["caps"] == [226]


def test_batch_cap_follows_the_longest_member(fake_qwen, tmp_path):
    e = make_engine(fake_qwen, tmp_path)

    e.synthesize_many(["x" * 30, "x" * 150, "x" * 60], "Ryan")

    assert fake_qwen["caps"] == [226]


def test_clone_calls_are_capped_per_item(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")

    e.synthesize_many(["x" * 30, "x" * 150], voice.id)

    # clone path is one model call per item, each with its own budget:
    # 30 chars -> 1.6 * 2s + 2s = 5.2s -> int(5.2 * 12.5) + 1 = 66 frames
    assert fake_qwen["caps"] == [66, 226]


def test_is_loaded_tracks_the_resident_variant(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    clone = e._clones.add(tv.clip_bytes(), name="Narrator A")

    assert not e.is_loaded("cuda", "Ryan")          # nothing resident yet
    e.prepare("cuda", "Ryan")
    assert e.is_loaded("cuda", "Ryan")
    assert e.is_loaded("cuda", "Ethan")             # same CustomVoice variant
    assert not e.is_loaded("cuda", clone.id)        # clones need the Base variant


def test_switching_variant_reports_loading_again(fake_qwen, tmp_path):
    import tests.test_voices as tv
    e = make_engine(fake_qwen, tmp_path)
    clone = e._clones.add(tv.clip_bytes(), name="Narrator A")
    e.prepare("cuda", "Ryan")

    seen = []
    original = e._load
    e._load = lambda variant: (seen.append(e.info()["loading"]), original(variant))[1]
    e.synthesize("Cloned line.", clone.id)

    assert seen[0] is True                          # base variant is a real load
    assert e.info()["loading"] is False


# --- sampling knobs (2026-09-10) -------------------------------------------
# The library ships do_sample=True at temperature 0.9 / top_p 1.0 and the engine
# used to pass only max_new_tokens, so every take inherited that. These pin it a
# notch narrower. On its own that only clipped the extreme tail (takes under
# 0.35 voiced: 4.8% -> 0%) and did not move the distribution (median delta
# -0.002, p=0.90) - the whispering was fixed by rewording the instruct, not
# here. See the comment on QWEN_TEMPERATURE for both measurements. What these
# tests guard is that the knobs reach every generate path and that retuning them
# re-rolls the cache, so the next person to try a value gets a clean read.

def test_preset_calls_pin_the_sampling_knobs(fake_qwen, tmp_path):
    from tts.qwen import QWEN_TEMPERATURE, QWEN_TOP_P
    e = make_engine(fake_qwen, tmp_path)

    e.synthesize("Hello there.", "Ryan")

    assert fake_qwen["sampling"] == [dict(
        temperature=QWEN_TEMPERATURE, top_p=QWEN_TOP_P,
        subtalker_temperature=QWEN_TEMPERATURE, subtalker_top_p=QWEN_TOP_P)]


def test_preset_batches_pin_the_sampling_knobs(fake_qwen, tmp_path):
    from tts.qwen import QWEN_TEMPERATURE, QWEN_TOP_P
    e = make_engine(fake_qwen, tmp_path)

    e.synthesize_many(["one.", "two.", "three."], "Ryan")

    assert len(fake_qwen["sampling"]) == 1                 # still one batched call
    assert fake_qwen["sampling"][0]["temperature"] == QWEN_TEMPERATURE
    assert fake_qwen["sampling"][0]["subtalker_top_p"] == QWEN_TOP_P


def test_clone_calls_pin_the_sampling_knobs(fake_qwen, tmp_path):
    import tests.test_voices as tv
    from tts.qwen import QWEN_TEMPERATURE, QWEN_TOP_P
    e = make_engine(fake_qwen, tmp_path)
    voice = e._clones.add(tv.clip_bytes(), name="Narrator A")

    e.synthesize("Cloned line.", voice.id)

    assert fake_qwen["sampling"] == [dict(
        temperature=QWEN_TEMPERATURE, top_p=QWEN_TOP_P,
        subtalker_temperature=QWEN_TEMPERATURE, subtalker_top_p=QWEN_TOP_P)]


def test_sampling_knobs_are_narrower_than_the_library_defaults():
    from tts.qwen import QWEN_TEMPERATURE, QWEN_TOP_P
    assert QWEN_TEMPERATURE < 0.9 and QWEN_TOP_P < 1.0


def test_fingerprint_covers_the_sampling_knobs(fake_qwen, tmp_path, monkeypatch):
    # Without this, retuning the sampler would leave every whispered take that
    # is already in cache/ playing back unchanged.
    import tests.test_voices as tv
    import tts.qwen as q
    e = make_engine(fake_qwen, tmp_path)
    clone = e._clones.add(tv.clip_bytes(), name="A")
    preset_before, clone_before = e.fingerprint("Ryan"), e.fingerprint(clone.id)

    monkeypatch.setattr(q, "QWEN_TEMPERATURE", q.QWEN_TEMPERATURE - 0.05)

    assert e.fingerprint("Ryan") != preset_before
    assert e.fingerprint(clone.id) != clone_before
