import io

import numpy as np
import pytest
import soundfile as sf

from tts.voices import CloneError, CloneStore


def clip_bytes(seconds=5.0, rate=24000):
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(seconds * rate), dtype=np.float32), rate, format="WAV")
    return buf.getvalue()


def test_add_creates_voice_with_stable_id(tmp_path):
    store = CloneStore(tmp_path)
    data = clip_bytes()
    voice = store.add(data, name="Narrator A")
    assert voice.id.startswith("clone:") and voice.group == "Cloned"
    assert store.add(data, name="Same clip").id == voice.id   # content-addressed
    assert store.ref_path(voice.id).exists()


def test_survives_reload_and_lists(tmp_path):
    CloneStore(tmp_path).add(clip_bytes(), name="Narrator A")
    voices = CloneStore(tmp_path).voices()                    # fresh instance
    assert [v.name for v in voices] == ["Narrator A"]


def test_rejects_bad_clips(tmp_path):
    store = CloneStore(tmp_path)
    with pytest.raises(CloneError, match="decode"):
        store.add(b"not audio at all", name="X")
    with pytest.raises(CloneError, match="3"):
        store.add(clip_bytes(seconds=1.0), name="Too short")
    with pytest.raises(CloneError, match="30"):
        store.add(clip_bytes(seconds=45.0), name="Too long")


def test_delete_and_fingerprint(tmp_path):
    store = CloneStore(tmp_path)
    voice = store.add(clip_bytes(), name="A")
    assert len(store.fingerprint(voice.id)) == 40             # full sha1
    assert store.delete(voice.id) is True
    assert store.voices() == [] and store.delete(voice.id) is False
