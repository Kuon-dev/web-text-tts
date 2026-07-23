import pytest

from tts.base import EngineUnavailable
from tts.device import GPU_RETRY_S, GPU_VRAM_POLL_S, DevicePolicy


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(allow_cpu=True, free=8 * 2**30, gpu=True, mode="auto", **kw):
    clock = Clock()
    state = {"free": free, "released": 0}
    policy = DevicePolicy(
        allow_cpu=allow_cpu, min_gpu_speed=1.5, min_free_bytes=1_500_000_000,
        mode=mode, gpu_available=gpu,
        release_gpu=lambda: state.__setitem__("released", state["released"] + 1),
        vram_free=lambda: state["free"], clock=clock, **kw)
    return policy, clock, state


def test_healthy_auto_picks_gpu():
    policy, _, _ = make()
    assert policy.pick() == "cuda"


def test_no_gpu_falls_to_cpu_or_unavailable():
    policy, _, _ = make(gpu=False)
    assert policy.pick() == "cpu"
    policy, _, _ = make(gpu=False, allow_cpu=False)
    with pytest.raises(EngineUnavailable):
        policy.pick()


def test_failed_gpu_backs_off_then_reprobes_when_vram_free():
    policy, clock, _ = make()
    policy.failed("stalled")
    assert policy.pick() == "cpu"                       # failover
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=False) == "cuda"          # probe after backoff


def test_probe_gated_on_free_vram():
    policy, clock, state = make(free=500 * 2**20)       # game holds VRAM
    policy.failed("contended")
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=False) == "cpu"           # gate closed -> no probe
    clock.t += GPU_VRAM_POLL_S + 1
    state["free"] = 8 * 2**30
    assert policy.pick(urgent=False) == "cuda"          # gate open -> probe


def test_slow_measurement_fails_gpu_fast_measurement_recovers():
    policy, clock, _ = make()
    policy.measured(0.4)                                # below min_gpu_speed
    assert policy.pick() == "cpu"
    clock.t += GPU_RETRY_S + 1
    assert policy.pick() == "cuda"
    policy.measured(9.0)
    assert policy.pick() == "cuda"                      # healthy again


def test_backoff_doubles_up_to_max():
    policy, clock, _ = make()
    policy.failed("a")
    first = policy._retry_at - clock.t
    clock.t += first + 1
    policy.pick()
    policy.failed("b")
    assert policy._retry_at - clock.t == pytest.approx(first * 2)


def test_no_cpu_engine_raises_instead_of_falling_back():
    policy, clock, _ = make(allow_cpu=False)
    policy.failed("contended")
    with pytest.raises(EngineUnavailable):
        policy.pick(urgent=True)
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=True) == "cuda"           # urgent may probe: no fallback exists


def test_pinned_modes():
    policy, _, _ = make(mode="gpu")
    policy.failed("ignored")
    assert policy.pick() == "cuda"                      # pinned gpu never fails over
    policy, _, state = make(mode="cpu")
    assert policy.pick() == "cpu"
    policy, _, _ = make(allow_cpu=False)
    with pytest.raises(ValueError):
        policy.set_mode("cpu")                          # unsupported for this engine
    with pytest.raises(ValueError):
        policy.set_mode("warp")


def test_cpu_mode_releases_gpu():
    policy, _, state = make()
    policy.set_mode("cpu")
    assert state["released"] == 1


def test_startup_vram_gate_in_auto():
    policy, _, _ = make(free=500 * 2**20)               # game already holding VRAM
    assert policy.pick() == "cpu"                       # starts unhealthy


def test_vram_probe_error_keeps_gate_closed():
    def boom():
        raise RuntimeError("driver unhappy")
    policy, clock, _ = make(free=0)
    policy._vram_free = boom
    policy.failed("contended")
    clock.t += GPU_RETRY_S + 1
    assert policy.pick(urgent=False) == "cpu"   # gate treats error as closed
