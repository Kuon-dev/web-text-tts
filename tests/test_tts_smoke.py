from pathlib import Path

import pytest
import soundfile as sf

from tts import SAMPLE_RATE, KokoroEngine


@pytest.mark.slow
def test_kokoro_generates_real_audio(tmp_path):
    engine = KokoroEngine()
    audio = engine.synthesize("Hello! This is a smoke test of the novel reader.", "af_heart")
    assert audio.ndim == 1
    assert len(audio) > SAMPLE_RATE  # > 1 second of speech
    out = tmp_path / "smoke.wav"
    sf.write(out, audio, SAMPLE_RATE)
    info = sf.info(out)
    assert info.samplerate == SAMPLE_RATE and info.duration > 1.0
