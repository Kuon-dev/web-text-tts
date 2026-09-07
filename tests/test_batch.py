"""Batched synthesis: engines opt in via max_batch, worker groups pending chunks."""
import numpy as np
import pytest

from tts.base import EngineUnavailable, TTSEngine, Voice


class FakePolicy:
    def __init__(self, device="cpu"):
        self.device = device
        self.measured_speeds, self.failures = [], []

    def pick(self, urgent=False):
        return self.device

    def measured(self, speed):
        self.measured_speeds.append(speed)

    def failed(self, reason):
        self.failures.append(reason)

    def info(self):
        return {"mode": "auto", "active": self.device, "gpu_available": False}


class ToyEngine(TTSEngine):
    """Single-item engine: no max_batch override, so it must stay at 1."""
    id = "toy"
    label = "Toy"
    default_voice = "v1"
    sample_rate = 24000

    def __init__(self, policy, seconds=1.0):
        super().__init__(policy)
        self.seconds = seconds
        self.generate_calls = []

    def _generate(self, text, voice, device):
        self.generate_calls.append(text)
        return np.zeros(int(self.seconds * self.sample_rate), dtype=np.float32)

    def voices(self):
        return [Voice(id="v1", name="V1", group="Toys", language="en")]

    def fingerprint(self, voice_id):
        return "fp1"


class BatchEngine(ToyEngine):
    """Opts into batching, like Qwen3."""
    max_batch = 4

    def __init__(self, policy, seconds=1.0):
        super().__init__(policy, seconds)
        self.batch_calls = []

    def _generate_batch(self, texts, voice, device):
        self.batch_calls.append(list(texts))
        return [np.zeros(int(self.seconds * self.sample_rate), dtype=np.float32)
                for _ in texts]


class BudgetEngine(BatchEngine):
    """Autoregressive-style engine that can overrun, like Qwen3: declares a
    budget factor and accepts the cap the base class derives from it.
    Texts in `overrun_texts` come back as 60s of audio, whatever the cap."""
    overrun_factor = 1.6

    def __init__(self, policy, seconds=1.0, overrun_texts=()):
        super().__init__(policy, seconds)
        self.overrun_texts = set(overrun_texts)
        self.caps = []                       # max_seconds seen by every model call

    def _length(self, text):
        secs = 60.0 if text in self.overrun_texts else self.seconds
        return int(secs * self.sample_rate)

    def _generate(self, text, voice, device, *, max_seconds=None):
        self.generate_calls.append(text)
        self.caps.append(max_seconds)
        return np.zeros(self._length(text), dtype=np.float32)

    def _generate_batch(self, texts, voice, device, *, max_seconds=None):
        self.batch_calls.append(list(texts))
        self.caps.append(max_seconds)
        return [np.zeros(self._length(t), dtype=np.float32) for t in texts]


class FakeClock:
    """Advances a fixed amount across one batch call, so speed is exact."""
    def __init__(self, step):
        self.t, self.step = 0.0, step

    def __call__(self):
        now = self.t
        self.t += self.step
        return now


def test_batch_speed_is_measured_on_total_audio_over_wall_clock(monkeypatch):
    clock = FakeClock(2.0)                        # each batch takes 2.0s
    monkeypatch.setattr("tts.base.time.monotonic", clock)
    engine = BatchEngine(FakePolicy(device="cuda"), seconds=2.0)

    engine.synthesize_many(["a", "b", "c"], "v1")   # 6.0s of audio in 2.0s

    assert engine.policy.measured_speeds == [3.0]


def test_a_fast_batch_below_the_sample_floor_is_not_measured(monkeypatch):
    monkeypatch.setattr("tts.base.time.monotonic", FakeClock(0.1))
    engine = BatchEngine(FakePolicy(device="cuda"), seconds=0.2)

    engine.synthesize_many(["a", "b"], "v1")        # 0.4s audio, 0.1s wall

    assert engine.policy.measured_speeds == []


def test_cpu_batches_are_never_measured(monkeypatch):
    monkeypatch.setattr("tts.base.time.monotonic", FakeClock(2.0))
    engine = BatchEngine(FakePolicy(device="cpu"), seconds=2.0)

    engine.synthesize_many(["a", "b", "c"], "v1")

    assert engine.policy.measured_speeds == []


class ManualClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class SlowLoadEngine(BatchEngine):
    """Model load costs `load` seconds the first time, generation costs `gen`.

    This is the shape that demoted a healthy GPU: lazily building the pipeline
    inside _generate charged a one-off load to the throughput measurement.
    """
    def __init__(self, policy, clock, load=10.0, gen=2.0, seconds=2.0):
        super().__init__(policy, seconds)
        self.clock, self.load, self.gen = clock, load, gen
        self.loaded, self.prepared = False, []

    def prepare(self, device, voice):
        self.prepared.append((device, voice))
        if not self.loaded:
            self.clock.t += self.load
            self.loaded = True

    def _generate_batch(self, texts, voice, device):
        if not self.loaded:                     # load lands inside the window
            self.clock.t += self.load
            self.loaded = True
        self.clock.t += self.gen
        return [np.zeros(int(self.seconds * self.sample_rate), dtype=np.float32)
                for _ in texts]


def test_model_load_is_not_charged_to_the_batch_speed(monkeypatch):
    clock = ManualClock()
    monkeypatch.setattr("tts.base.time.monotonic", clock)
    engine = SlowLoadEngine(FakePolicy(device="cuda"), clock)

    engine.synthesize_many(["a", "b", "c", "d"], "v1")   # 8s audio, 2s of work

    assert engine.prepared == [("cuda", "v1")]
    assert engine.policy.measured_speeds == [4.0]        # 8/2, not 8/12


def test_single_synthesize_also_prepares_before_timing(monkeypatch):
    clock = ManualClock()
    monkeypatch.setattr("tts.base.time.monotonic", clock)

    class SlowSingle(SlowLoadEngine):
        max_batch = 1

        def _generate(self, text, voice, device):
            if not self.loaded:
                self.clock.t += self.load
                self.loaded = True
            self.clock.t += self.gen
            return np.zeros(int(4.0 * self.sample_rate), dtype=np.float32)

    engine = SlowSingle(FakePolicy(device="cuda"), clock)

    engine.synthesize("a", "v1")                         # 4s audio, 2s of work

    assert engine.prepared == [("cuda", "v1")]
    assert engine.policy.measured_speeds == [2.0]        # 4/2, not 4/12


class ExplodingBatchEngine(BatchEngine):
    def __init__(self, policy, exc):
        super().__init__(policy)
        self.exc = exc

    def _generate_batch(self, texts, voice, device):
        raise self.exc


def test_a_failed_gpu_batch_tells_the_policy_the_gpu_failed():
    engine = ExplodingBatchEngine(FakePolicy(device="cuda"), RuntimeError("boom"))

    with pytest.raises(RuntimeError):
        engine.synthesize_many(["a", "b"], "v1")

    assert engine.policy.failures == ["boom"]


def test_engine_unavailable_is_a_gate_not_a_gpu_failure():
    engine = ExplodingBatchEngine(FakePolicy(device="cuda"),
                                  EngineUnavailable("weights loading"))

    with pytest.raises(EngineUnavailable):
        engine.synthesize_many(["a", "b"], "v1")

    assert engine.policy.failures == []


def test_unspeakable_items_get_silence_without_reaching_the_model():
    engine = BatchEngine(FakePolicy())

    out = engine.synthesize_many(["* * *", "real text"], "v1")

    assert len(out) == 2
    assert engine.batch_calls == [["real text"]]      # separators never batched
    assert len(out[0]) == int(0.4 * engine.sample_rate)


def test_default_engine_declares_no_batching():
    assert ToyEngine(FakePolicy()).max_batch == 1


def test_batch_engine_generates_every_item_in_one_call():
    engine = BatchEngine(FakePolicy())

    out = engine.synthesize_many(["a", "b", "c"], "v1")

    assert len(out) == 3
    assert engine.batch_calls == [["a", "b", "c"]]
    assert engine.generate_calls == []       # never fell back to per-item


def test_synthesize_many_returns_one_audio_array_per_item():
    engine = ToyEngine(FakePolicy())

    out = engine.synthesize_many(["alpha", "beta", "gamma"], "v1")

    assert len(out) == 3
    assert all(isinstance(a, np.ndarray) for a in out)
    assert engine.generate_calls == ["alpha", "beta", "gamma"]


def test_engines_without_a_factor_have_no_budget():
    assert ToyEngine(FakePolicy()).budget_seconds("any text at all") is None
    assert BatchEngine(FakePolicy()).budget_seconds("any text at all") is None


def test_budget_is_factor_times_narration_pace_plus_floor():
    engine = BudgetEngine(FakePolicy())

    # 150 chars = 10s at 15 chars/s; 1.6x + 2s floor
    assert engine.budget_seconds("x" * 150) == pytest.approx(18.0)
    # interjections are dominated by the floor
    assert engine.budget_seconds("Mm.") == pytest.approx(1.6 * 3 / 15 + 2.0)
