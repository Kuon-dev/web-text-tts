"""Romaji name G2P: Japanese names in translated novels get rule-based
phonemes instead of espeak's English spelling-rule guesses."""
import json
import sys
import types
from pathlib import Path

import pytest

from romaji import RomajiFallback, romaji_phonemes


@pytest.mark.parametrize("name,phonemes", [
    ("Shion", "ʃˈiOn"),            # espeak said "shun" (one syllable)
    ("Touka", "tˈOkɑ"),            # espeak said "TOW-ka" as in "cow"
    ("Souta", "sˈOtɑ"),
    ("Sasuke", "sɑsˈukA"),         # espeak dropped the final e (silent-e rule)
    ("Ryuunosuke", "ɹjunOsˈukA"),
    ("Kaguya", "kɑɡˈujɑ"),
    ("Tsukishima", "tsukiʃˈimɑ"),
    ("Yukinoshita", "jukinOʃˈitɑ"),
    ("Senpai", "sˈɛnpI"),
    ("Sempai", "sˈɛmpI"),          # m-before-p spelling variant
    ("Onii-chan", "ˈOniʧˈɑn"),     # hyphen parts converted separately
    ("Onee-chan", "ˈOnAʧˈɑn"),
    ("Kaguya-sama", "kɑɡˈujɑsˈɑmɑ"),
    ("Souta's", "sˈOtɑz"),         # possessive
    ("Jun'ichi", "ʤunˈiʧi"),       # apostrophe marks syllabic n
    ("Rei", "ɹˈA"),
    ("Satoh", "sˈɑtO"),            # "oh"-style long vowel
    ("Kotone", "kOtˈOnA"),
    ("Kyouko", "kjˈOkO"),
])
def test_japanese_names_get_rule_based_phonemes(name, phonemes):
    assert romaji_phonemes(name) == phonemes


@pytest.mark.parametrize("word", [
    "Alice", "Hermione", "Voldemort", "strength", "world", "the",
    "quest", "cryptid", "blorp", "xyz", "mp3", "a", "e", "n",
])
def test_non_romaji_words_are_rejected(word):
    assert romaji_phonemes(word) is None


def test_fallback_converts_romaji_and_delegates_the_rest():
    calls = []

    def delegate(token):
        calls.append(token.text)
        return "dɪlɪɡˈeɪtɪd", 2

    fb = RomajiFallback(delegate)
    tok = types.SimpleNamespace(text="Shion")
    ps, rating = fb(tok)
    assert ps == "ʃˈiOn" and rating is not None
    assert calls == []

    tok = types.SimpleNamespace(text="Hermione")
    ps, rating = fb(tok)
    assert ps == "dɪlɪɡˈeɪtɪd"
    assert calls == ["Hermione"]


def test_fallback_without_delegate_still_handles_romaji():
    fb = RomajiFallback(None)
    assert fb(types.SimpleNamespace(text="Touka"))[0] == "tˈOkɑ"
    assert fb(types.SimpleNamespace(text="Hermione")) == (None, None)


def test_phonemes_stay_within_kokoro_vocab():
    # every character we emit must already appear in misaki's own gold
    # lexicon (plus stress marks) — unknown symbols would be dropped or
    # crash tokenization inside the model
    import misaki
    gold = json.loads(
        (Path(misaki.__file__).parent / "data" / "us_gold.json").read_text())
    charset = {"ˈ", "ˌ"}

    def collect(v):
        if isinstance(v, str):
            charset.update(v)
        elif isinstance(v, dict):
            for x in v.values():
                collect(x)

    for v in gold.values():
        collect(v)
    for name in ["Ryuunosuke", "Shion", "Kaguya-sama", "Souta's", "Onii-chan"]:
        assert set(romaji_phonemes(name)) <= charset


def test_pipeline_wraps_g2p_fallback(monkeypatch):
    from tts import KokoroEngine

    original = object()

    class FakePipeline:
        def __init__(self, lang_code=None, device=None):
            self.g2p = types.SimpleNamespace(fallback=original)

    monkeypatch.setitem(
        sys.modules, "kokoro", types.SimpleNamespace(KPipeline=FakePipeline))
    e = KokoroEngine.__new__(KokoroEngine)
    e._pipelines = {}
    pipe = e._pipeline("af_heart", "cpu")
    assert isinstance(pipe.g2p.fallback, RomajiFallback)
    assert pipe.g2p.fallback.delegate is original
