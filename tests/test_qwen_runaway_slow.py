"""Real-model runaway regression: needs a GPU with ~3 GiB free and qwen-tts.

Reproduces the 2026-09-07 finding (spec of the same date): at batch 1 the
0.6B model produced 28.4s of breathing for a 44-char line. With budgets in
place nothing may come back over budget, batched or alone.
"""
import numpy as np
import pytest

pytestmark = pytest.mark.slow

TEXTS = [
    "The gates of the old capital rose out of the morning mist, and for a moment "
    "nobody in the caravan spoke. Kaede tightened her grip on the reins. Whatever "
    "waited past those walls, it could not be worse than another winter on the road.",
    "「I told you already. We leave at first light, and we do not look back.」 "
    "She turned away before he could answer.",
    "「Mm.」",
    "「Eh?」",
    "「───!」",
    "「Haa... haa... haa... I can't... breathe...」",
]


@pytest.fixture(scope="module")
def engine():
    pytest.importorskip("qwen_tts")
    torch = pytest.importorskip("torch")
    if not torch.cuda.is_available():
        pytest.skip("needs CUDA")
    from tts.qwen import Qwen3Engine
    return Qwen3Engine(mode="gpu")


def test_no_batched_item_exceeds_its_budget(engine):
    for _ in range(2):                                   # sampling is stochastic
        out = engine.synthesize_many(TEXTS, "Ryan")
        for text, audio in zip(TEXTS, out):
            budget = engine.budget_seconds(text)
            assert len(audio) <= int(budget * engine.sample_rate), \
                f"{len(audio) / engine.sample_rate:.1f}s > {budget:.1f}s for {text[:30]!r}"
            assert float(np.abs(audio).max()) > 0.01


def test_the_breathing_line_alone_is_bounded(engine):
    text = TEXTS[-1]
    for _ in range(3):
        audio = engine.synthesize(text, "Ryan")
        assert len(audio) <= int(engine.budget_seconds(text) * engine.sample_rate)
