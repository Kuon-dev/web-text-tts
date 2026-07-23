"""Real TTSWorker + real EngineManager meeting each other, no fakes on either
side (only the innermost TTSEngine is a toy). Per-component unit tests fake
the *other* side (FakeManager in test_server.py, FakeWorker/FakeEngine in
test_worker.py/test_manager.py) and so never exercise worker->manager under
the manager's real lock, or a worker surviving a real manager.swap - exactly
where a status-endpoint deadlock (fixed alongside this test) hid through
many reviews. Torch-free: the toy engine never imports torch."""
import numpy as np

from chunker import Chunk, chunk_id
from tts.base import TTSEngine, Voice
from tts.device import DevicePolicy
from tts.manager import EngineManager
from tts.worker import TTSWorker


class ToyEngine(TTSEngine):
    """Minimal TTSEngine: real DevicePolicy plumbing (gpu_available=False, so
    it always picks "cpu" and never touches torch), trivial generation."""

    label = "Toy"
    default_voice = "v"
    sample_rate = 24000

    def __init__(self, engine_id: str):
        self.id = engine_id
        super().__init__(DevicePolicy(allow_cpu=True, min_gpu_speed=0.0,
                                      min_free_bytes=0, mode="auto", gpu_available=False))

    def _generate(self, text, voice, device):
        return np.zeros(240, dtype=np.float32)  # short: a few ms of silence

    def voices(self):
        return [Voice(id="v", name="V", group="G", language="en")]

    def fingerprint(self, voice_id):
        return "fp"


TOY_ENGINES = {"a": ToyEngine, "b": ToyEngine}


def _factory(engine_id, mode, clone_store):
    return TOY_ENGINES[engine_id](engine_id)


def test_worker_request_completes_through_real_manager(tmp_path):
    manager = EngineManager(tmp_path, engine_id="a", mode="auto", factory=_factory)
    worker = TTSWorker(tmp_path / "cache", manager)
    chunks = [Chunk(text="Hello there.", para=0)]
    ns = manager.chunk_namespace("v")
    worker.set_doc(chunks, ns, "v")
    cid = chunk_id(ns, chunks[0].text)

    event = worker.request(cid)
    assert event.wait(5.0)          # worker->manager.synthesize under the real manager lock
    assert worker.path(cid).exists()


def test_worker_generates_after_manager_swap_while_idle(tmp_path):
    manager = EngineManager(tmp_path, engine_id="a", mode="auto", factory=_factory)
    worker = TTSWorker(tmp_path / "cache", manager)
    chunks = [Chunk(text="Hello there.", para=0)]
    ns_a = manager.chunk_namespace("v")
    worker.set_doc(chunks, ns_a, "v")
    cid_a = chunk_id(ns_a, chunks[0].text)
    assert worker.request(cid_a).wait(5.0)
    assert worker.path(cid_a).exists()   # worker now idle, nothing left to generate

    manager.swap("b", "auto")
    ns_b = manager.chunk_namespace("v")
    assert ns_b != ns_a                  # new engine id -> new namespace
    worker.set_doc(chunks, ns_b, "v")
    cid_b = chunk_id(ns_b, chunks[0].text)

    assert worker.request(cid_b).wait(5.0)
    assert worker.path(cid_b).exists()
