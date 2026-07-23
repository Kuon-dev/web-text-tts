"""Real-model smoke: needs GPU + qwen-tts (Task 12 runs this on the 4060 box)."""
import numpy as np
import pytest

pytestmark = pytest.mark.slow


def test_qwen_preset_speaks():
    from tts.qwen import Qwen3Engine
    engine = Qwen3Engine(mode="gpu")
    audio = engine.synthesize("The morning mist rose over the old capital.", "Ryan")
    assert len(audio) > engine.sample_rate  # >1s of real audio
    assert float(np.abs(audio).max()) > 0.01
