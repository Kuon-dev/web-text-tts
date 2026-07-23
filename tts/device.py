"""The auto/gpu/cpu failover state machine, extracted from KokoroEngine so
every engine composes it with its own thresholds (Strategy). See the long
rationale comment in tts/kokoro.py for the contention story it encodes."""
import logging
import time

from .base import DEVICE_MODES, EngineUnavailable

log = logging.getLogger("novel-tts")

GPU_RETRY_S = 600.0
GPU_RETRY_MAX_S = 3600.0
GPU_VRAM_POLL_S = 30.0


def _torch_vram_free() -> int:
    import torch
    free, _total = torch.cuda.mem_get_info()
    return free


class DevicePolicy:
    def __init__(self, *, allow_cpu: bool, min_gpu_speed: float, min_free_bytes: int,
                 mode: str = "auto", gpu_available: bool = False,
                 release_gpu=lambda: None, vram_free=_torch_vram_free,
                 clock=time.monotonic):
        self.allow_cpu = allow_cpu
        self.min_gpu_speed = min_gpu_speed
        self.min_free_bytes = min_free_bytes
        self.gpu_available = gpu_available
        self._release_gpu = release_gpu
        self._vram_free = vram_free
        self._clock = clock
        self._mode = "auto"
        self._gpu_ok = True
        self._retry_at = 0.0
        self._retry_wait = GPU_RETRY_S
        self._vram_wait_logged = False
        self.set_mode(mode if mode in self._supported() else "auto")
        if self._mode == "auto" and gpu_available and not self._vram_gate_open():
            self._gpu_ok = False                      # game already holds VRAM
            self._retry_at = self._clock() + GPU_RETRY_S

    def _supported(self):
        return DEVICE_MODES if self.allow_cpu else ("auto", "gpu")

    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str) -> None:
        if mode not in self._supported():
            raise ValueError(f"unsupported device mode: {mode}")
        if mode == self._mode:
            return
        self._mode = mode
        log.info("device mode -> %s", mode)
        if mode == "cpu":
            self._release_gpu()
        else:
            self._gpu_ok = True       # fresh optimism; re-measured on next chunk
            self._retry_wait = GPU_RETRY_S

    def pick(self, urgent: bool = False) -> str:
        if not self.gpu_available or self._mode == "cpu":
            return self._cpu_or_raise("no GPU available")
        if self._mode == "gpu" or self._gpu_ok:
            return "cuda"
        # auto + unhealthy: probe after backoff, gated on free VRAM. With no
        # CPU fallback, urgent chunks may probe too - nothing else serves them.
        if (not urgent or not self.allow_cpu) and self._clock() >= self._retry_at:
            if self._vram_gate_open():
                return "cuda"
            self._retry_at = self._clock() + GPU_VRAM_POLL_S
        return self._cpu_or_raise("GPU contended, no CPU fallback")

    def _cpu_or_raise(self, reason: str) -> str:
        if self.allow_cpu:
            return "cpu"
        raise EngineUnavailable(reason)

    def _vram_gate_open(self) -> bool:
        try:
            free = self._vram_free()
        except Exception:
            return False              # driver unhappy - a probe would fare no better
        if free >= self.min_free_bytes:
            self._vram_wait_logged = False
            return True
        if not self._vram_wait_logged:
            self._vram_wait_logged = True    # one line per contention episode
            log.info("GPU has only %dMB free - waiting for VRAM", free // 2**20)
        return False

    def failed(self, reason: str) -> None:
        if self._mode != "auto":
            return                    # pinned modes: the user chose this
        level = log.warning if self._gpu_ok else log.info
        level("GPU %s - next GPU try in %.0fs", reason, self._retry_wait)
        self._gpu_ok = False
        self._retry_at = self._clock() + self._retry_wait
        self._retry_wait = min(self._retry_wait * 2, GPU_RETRY_MAX_S)
        self._release_gpu()

    def measured(self, speed: float) -> None:
        if self._mode != "auto":
            return
        if speed < self.min_gpu_speed:
            self.failed(f"at {speed:.2f}x realtime (contended)")
        elif not self._gpu_ok:
            log.info("GPU recovered (%.1fx realtime)", speed)
            self._gpu_ok = True
            self._retry_wait = GPU_RETRY_S

    def info(self) -> dict:
        on_gpu = (self.gpu_available and self._mode != "cpu"
                  and (self._mode == "gpu" or self._gpu_ok))
        return {"mode": self._mode, "active": "gpu" if on_gpu else "cpu",
                "gpu_available": self.gpu_available}
