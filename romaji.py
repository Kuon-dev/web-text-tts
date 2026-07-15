"""Rule-based G2P for romanized Japanese names in English text.

Translated light novels are full of names misaki's English dictionary
doesn't know, so they land in the espeak-ng fallback — which applies
English spelling rules to romaji, a different orthography. Measured
damage: "Shion" -> "shun" (one syllable), "Touka" -> "TOW-ka" (ou as in
"out" instead of long o), "Sasuke" -> "SASS-ook" (silent final e).

Romaji is regular enough that a strict kana-syllable parser both detects
it (words that don't parse are left to espeak, so English OOV words are
unaffected) and converts it: every vowel is kept (no schwa collapse),
ou/oo/uu merge into one long vowel, final e is pronounced ("kay"), and
stress falls on the penultimate syllable — the standard English loanword
pattern (ka-TA-na, hi-ro-SHI-ma).

Phonemes use Kokoro's American English alphabet (O = oʊ, A = eɪ, I = aɪ,
W = aʊ, Y = ɔɪ); the vocab test keeps us inside the model's charset.
"""

# longest match first: digraphs and y-glides before their single-letter
# prefixes ("ryu" must not parse as r+yu)
_ONSETS = [
    ("ky", "kj"), ("gy", "ɡj"), ("ny", "nj"), ("hy", "hj"), ("by", "bj"),
    ("py", "pj"), ("my", "mj"), ("ry", "ɹj"), ("sh", "ʃ"), ("ch", "ʧ"),
    ("ts", "ts"),
    ("k", "k"), ("g", "ɡ"), ("s", "s"), ("z", "z"), ("j", "ʤ"),
    ("t", "t"), ("d", "d"), ("n", "n"), ("h", "h"), ("f", "f"),
    ("b", "b"), ("p", "p"), ("m", "m"), ("y", "j"), ("r", "ɹ"),
    ("w", "w"),
]
_VOWELS = "aiueo"
_VOWEL_PH = {"a": "ɑ", "i": "i", "u": "u", "e": "ɛ", "o": "O"}
# adjacent vowels that read as one long vowel / diphthong in romaji
_MERGED = {"aa": "ɑ", "ii": "i", "uu": "u", "ee": "A", "oo": "O",
           "ou": "O", "ei": "A", "ai": "I", "au": "W", "oi": "Y"}
_DOUBLES = {"kk", "gg", "ss", "zz", "tt", "dd", "bb", "pp"}  # geminates
_MACRONS = str.maketrans({"ā": "aa", "ī": "ii", "ū": "uu", "ē": "ee",
                          "ō": "ou", "â": "aa", "î": "ii", "û": "uu",
                          "ê": "ee", "ô": "ou"})


def _parse(word: str) -> list | None:
    """word -> [["V", onset_phonemes, vowel_letters] | ["N", coda]] or None."""
    units, i, n = [], 0, len(word)
    while i < n:
        c = word[i]
        nxt = word[i + 1] if i + 1 < n else ""
        if c == "n" and (nxt == "'" or not nxt or nxt not in _VOWELS + "y"):
            units.append(["N", "n"])  # syllabic n (n' before a vowel)
            i += 2 if nxt == "'" else 1
            continue
        if c == "m" and nxt and nxt in "bp":
            units.append(["N", "m"])  # senpai/sempai spelling variant
            i += 1
            continue
        if (c == "h" and (not nxt or nxt not in _VOWELS + "y")
                and units and units[-1][0] == "V"):
            i += 1  # "Satoh"-style long-vowel marker
            continue
        if c + nxt in _DOUBLES or (c in "tc" and word[i + 1:i + 3] == "ch"):
            i += 1  # geminate: English voices can't hold it anyway
            continue
        for onset, ph in _ONSETS:
            vowel = word[i + len(onset):i + len(onset) + 1]
            if word.startswith(onset, i) and vowel and vowel in _VOWELS:
                units.append(["V", ph, vowel])
                i += len(onset) + 1
                break
        else:
            if c in _VOWELS:
                units.append(["V", "", c])
                i += 1
            else:
                return None  # not a kana-legal syllable -> not romaji
    return units


def _merge_long_vowels(units: list) -> list:
    out = []
    for u in units:
        if (u[0] == "V" and not u[1] and out and out[-1][0] == "V"
                and len(out[-1][2]) == 1 and out[-1][2] + u[2] in _MERGED):
            out[-1][2] += u[2]
        else:
            out.append(u)
    return out


def _assemble(units: list) -> str | None:
    vowels = [u for u in units if u[0] == "V"]
    if not vowels:
        return None
    stressed = vowels[-2] if len(vowels) > 1 else vowels[-1]
    parts = []
    for u in units:
        if u[0] == "N":
            parts.append(u[1])
            continue
        if len(u[2]) == 2:
            v = _MERGED[u[2]]
        elif u[2] == "e" and u is units[-1]:
            v = "A"  # final e is pronounced: Sasuke -> "sah-soo-kay"
        else:
            v = _VOWEL_PH[u[2]]
        parts.append(u[1] + ("ˈ" if u is stressed else "") + v)
    return "".join(parts)


def romaji_phonemes(word: str) -> str | None:
    """Kokoro phonemes for a romaji word, or None if it isn't romaji."""
    w = word.strip().lower().replace("’", "'").translate(_MACRONS)
    possessive = w.endswith("'s")
    if possessive:
        w = w[:-2]
    parts = w.split("-")
    if not all(len(p) >= 2 and p.replace("'", "").isascii()
               and p.replace("'", "").isalpha() for p in parts):
        return None
    phonemes = []
    for p in parts:
        units = _parse(p)
        ph = _assemble(_merge_long_vowels(units)) if units else None
        if ph is None:
            return None
        phonemes.append(ph)
    return "".join(phonemes) + ("z" if possessive else "")


class RomajiFallback:
    """misaki G2P fallback: romaji words get rule-based phonemes, anything
    else goes to the wrapped fallback (espeak-ng, or None if it failed to
    load — in which case romaji names still work)."""

    def __init__(self, delegate=None):
        self.delegate = delegate

    def __call__(self, token):
        ps = romaji_phonemes(token.text)
        if ps is not None:
            return ps, 3  # rule-based: better than an espeak guess (2)
        if self.delegate is not None:
            return self.delegate(token)
        return None, None
