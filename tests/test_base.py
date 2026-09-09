import numpy as np
import pytest

from tts.base import DEVICE_MODES, EngineUnavailable, TTSEngine, Voice


class FakePolicy:
    def __init__(self, device="cpu"):
        self.device = device
        self.measured_speeds, self.failures, self.modes = [], [], []

    def pick(self, urgent=False):
        return self.device

    def measured(self, speed):
        self.measured_speeds.append(speed)

    def failed(self, reason):
        self.failures.append(reason)

    def set_mode(self, mode):
        self.modes.append(mode)

    def info(self):
        return {"mode": "auto", "active": self.device, "gpu_available": False}


class ToyEngine(TTSEngine):
    id = "toy"
    label = "Toy"
    default_voice = "v1"
    sample_rate = 24000

    def __init__(self, policy, fail=False, seconds=1.0):
        super().__init__(policy)
        self.fail = fail
        self.seconds = seconds

    def _generate(self, text, voice, device):
        if self.fail:
            raise RuntimeError("boom")
        return np.zeros(int(self.seconds * self.sample_rate), dtype=np.float32)

    def voices(self):
        return [Voice(id="v1", name="V1", group="Toys", language="en")]

    def fingerprint(self, voice_id):
        return "fp1"


def test_unspeakable_returns_silence_without_touching_policy():
    policy = FakePolicy()
    audio = ToyEngine(policy).synthesize("* * *", "v1")
    assert len(audio) == int(0.4 * 24000)
    assert policy.measured_speeds == [] and policy.failures == []


def test_default_is_speakable_accepts_cjk():
    engine = ToyEngine(FakePolicy())
    assert engine.is_speakable("彼女は頷いた。")     # kanji/kana are \w
    assert engine.is_speakable("Hello.")
    assert not engine.is_speakable("◆ ◆ ◆")


def test_gpu_failure_reported_to_policy_and_reraised():
    policy = FakePolicy(device="cuda")
    with pytest.raises(RuntimeError):
        ToyEngine(policy, fail=True).synthesize("Hello there.", "v1")
    assert policy.failures == ["boom"]


def test_cpu_failure_not_reported_as_gpu_failure():
    policy = FakePolicy(device="cpu")
    with pytest.raises(RuntimeError):
        ToyEngine(policy, fail=True).synthesize("Hello there.", "v1")
    assert policy.failures == []


def test_engine_unavailable_passes_through_unwrapped():
    class GatedPolicy(FakePolicy):
        def pick(self, urgent=False):
            raise EngineUnavailable("gpu contended")

    with pytest.raises(EngineUnavailable):
        ToyEngine(GatedPolicy()).synthesize("Hello there.", "v1")


def test_info_merges_engine_identity_with_policy():
    info = ToyEngine(FakePolicy()).info()
    assert info["engine"] == "toy" and info["label"] == "Toy"
    assert info["mode"] == "auto" and info["loading"] is False


def test_device_modes_tuple():
    assert DEVICE_MODES == ("auto", "gpu", "cpu")
    assert TTSEngine.supported_modes == DEVICE_MODES


class LoadingEngine(ToyEngine):
    """Records what info()["loading"] says from inside prepare()."""

    def __init__(self, policy, resident=False, fail_prepare=False):
        super().__init__(policy)
        self.resident = resident
        self.fail_prepare = fail_prepare
        self.prepares = 0
        self.seen_loading = []

    def is_loaded(self, device, voice):
        return self.resident

    def prepare(self, device, voice):
        self.prepares += 1
        self.seen_loading.append(self.info()["loading"])
        if self.fail_prepare:
            raise RuntimeError("weights missing")


def test_loading_is_true_while_prepare_runs_and_false_after():
    engine = LoadingEngine(FakePolicy())
    engine.synthesize("Hello there.", "v1")
    assert engine.seen_loading == [True]
    assert engine.info()["loading"] is False


def test_resident_weights_still_prepare_but_never_report_loading():
    engine = LoadingEngine(FakePolicy(), resident=True)
    engine.synthesize("Hello there.", "v1")
    assert engine.prepares == 1          # prepare() stays unconditional
    assert engine.seen_loading == [False]


def test_loading_cleared_when_prepare_raises():
    engine = LoadingEngine(FakePolicy(), fail_prepare=True)
    with pytest.raises(RuntimeError):
        engine.synthesize("Hello there.", "v1")
    assert engine.info()["loading"] is False


def test_batch_path_reports_loading_too():
    class BatchEngine(LoadingEngine):
        max_batch = 4

    engine = BatchEngine(FakePolicy())
    engine.synthesize_many(["One.", "Two."], "v1")
    assert engine.seen_loading == [True]
    assert engine.info()["loading"] is False


def test_engine_that_never_says_it_loads_defaults_to_not_loading():
    engine = ToyEngine(FakePolicy())
    assert engine.is_loaded("cpu", "v1") is True
    engine.synthesize("Hello there.", "v1")
    assert engine.info()["loading"] is False
