from tts.kokoro import PRONUNCIATION_V, VOICES, KokoroEngine


def make_engine():
    e = KokoroEngine.__new__(KokoroEngine)   # skip __init__: no torch in CI
    e._pipelines = {}
    return e


def test_identity_and_modes():
    assert KokoroEngine.id == "kokoro"
    assert KokoroEngine.supported_modes == ("auto", "gpu", "cpu")
    assert KokoroEngine.default_voice == "af_heart"


def test_voices_metadata():
    voices = make_engine().voices()
    assert [v.id for v in voices] == VOICES
    by_id = {v.id: v for v in voices}
    assert by_id["af_heart"].name == "Heart"
    assert by_id["af_heart"].group == "US female"
    assert by_id["bm_fable"].group == "UK male"
    assert by_id["am_adam"].language == "en-US"
    assert by_id["bf_emma"].language == "en-GB"


def test_fingerprint_is_pronunciation_version():
    assert make_engine().fingerprint("af_heart") == PRONUNCIATION_V == "2"


def test_is_speakable_stays_ascii_only():
    e = make_engine()                        # a/b voices can't speak Japanese:
    assert not e.is_speakable("彼女は頷いた。")  # silencing kanji is correct HERE
    assert not e.is_speakable("* * *")
    assert e.is_speakable("Hello.")
