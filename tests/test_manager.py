import threading
import time

import numpy as np
import pytest

from tts.base import TTSEngine, Voice
from tts.manager import EngineManager


class StubEngine(TTSEngine):
    label = "Stub"
    supported_modes = ("auto", "gpu")
    default_voice = "v"
    sample_rate = 24000

    def __init__(self, eid, block=0.0):
        self.id = eid
        self.block = block
        self.unloaded = False
        self.instructs, self.modes = [], []
        self.policy = None            # not used: we override the plumbing

    def synthesize(self, text, voice, urgent=False):
        time.sleep(self.block)
        return np.zeros(10, dtype=np.float32)

    def _generate(self, text, voice, device):
        raise AssertionError("unused")

    def voices(self):
        return [Voice(id="v", name="V", group="G", language="en")]

    def fingerprint(self, voice_id):
        return f"fp-{self.id}"

    def set_mode(self, mode):
        self.modes.append(mode)

    def set_instruct(self, text):
        self.instructs.append(text)

    def info(self):
        return {"engine": self.id, "label": self.label, "cold": False,
                "mode": "auto", "active": "gpu", "gpu_available": True}

    def unload(self):
        self.unloaded = True


def make_manager(tmp_path, engines):
    return EngineManager(tmp_path, engine_id="a", mode="auto",
                         factory=lambda eid, mode, clone_store: engines[eid](eid))


def test_namespace_folds_engine_fingerprint_voice(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    assert mgr.chunk_namespace("v") == "a\x00fp-a\x00v"


def test_swap_unloads_old_and_changes_namespace(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine, "b": StubEngine})
    old = mgr._engine
    mgr.swap("b", "auto")
    assert old.unloaded and mgr.engine_id == "b"
    assert mgr.chunk_namespace("v") == "b\x00fp-b\x00v"
    mgr.swap("b", "auto")
    assert mgr._engine is not None and mgr.engine_id == "b"   # no-op, no rebuild


def test_swap_waits_for_inflight_synthesize(tmp_path):
    slow = StubEngine("a", block=0.2)
    mgr = make_manager(tmp_path, {"a": lambda eid: slow, "b": StubEngine})
    t = threading.Thread(target=lambda: mgr.synthesize("hi", "v"))
    t.start()
    time.sleep(0.05)                  # thread is inside synthesize, holding the lock
    start = time.monotonic()
    mgr.swap("b", "auto")
    assert time.monotonic() - start > 0.1   # swap had to wait for the chunk
    t.join()


def test_unknown_engine_raises_and_keeps_current(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    with pytest.raises(KeyError):
        mgr.swap("nope", "auto")
    assert mgr.engine_id == "a"


def test_delegation(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    mgr.set_instruct("calm")
    mgr.set_mode("gpu")
    assert mgr._engine.instructs == ["calm"] and mgr._engine.modes == ["gpu"]
    assert mgr.sample_rate == 24000 and mgr.info()["engine"] == "a"
    assert [v.id for v in mgr.voices()] == ["v"]


def test_default_voice_delegates(tmp_path):
    mgr = make_manager(tmp_path, {"a": StubEngine})
    assert mgr.default_voice() == "v"
