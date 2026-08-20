"""Background generate-ahead worker writing WAVs to a hash cache."""
import logging
import threading
import time
from itertools import chain
from pathlib import Path

import soundfile as sf

from chunker import Chunk, chunk_id

from .base import EngineUnavailable

log = logging.getLogger("novel-tts")

CACHE_CAP_BYTES = 2 * 1024 ** 3

# Soon-needed window: chunks playback will reach in the next few minutes are
# generated regardless of contention. Beyond it the worker back-fills the
# whole document (position -> end, then wrap-around to cover rewinds), but
# only while measured speed shows a free GPU: a worker busy on a far chunk
# delays urgent jumps by a whole in-flight generation and fights the game
# for the GPU. While slow, one probe chunk per FILL_PROBE_S keeps the speed
# reading fresh. The byte budget stops the fill just short of the cache cap
# so a pathological paste can never evict-and-regenerate its own audio.
CHARS_PER_SECOND = 15.0  # narration pace measured on real chapters
LOOKAHEAD_SECONDS = 180.0
LOOKAHEAD_MAX_CHUNKS = 64
# Informational default (matches Kokoro's rate); the live estimate used by
# _pick() reads the actual engine's sample_rate, since engines differ.
EST_BYTES_PER_CHAR = 24000 * 2 / CHARS_PER_SECOND  # PCM16 mono WAV
FILL_BUDGET_BYTES = CACHE_CAP_BYTES * 0.9
FILL_MIN_SPEED = 4.0
FILL_PROBE_S = 90.0
MAX_ATTEMPTS = 2


class TTSWorker:
    def __init__(self, cache_dir: Path, engine,
                 unavailable_wait: float = 5.0,
                 fill_min_speed: float = FILL_MIN_SPEED,
                 fill_probe_interval: float = FILL_PROBE_S):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._engine = engine
        self._unavailable_wait = unavailable_wait
        self._fill_min_speed = fill_min_speed
        self._fill_probe_interval = fill_probe_interval
        self._speed = 0.0  # last measured generation speed, x realtime
        self._last_fill_probe = time.monotonic() - fill_probe_interval
        self._cond = threading.Condition()
        self._chunks: list[Chunk] = []
        self._cids: list[str] = []
        self._namespace = ""
        self._voice = ""
        self._position = 0
        self._requests: list[str] = []
        self._attempts: dict[str, int] = {}
        self._failed: set[str] = set()
        self._blocked: str | None = None
        self._events: dict[str, threading.Event] = {}
        self._thread = threading.Thread(target=self._run, daemon=True, name="tts-worker")
        self._thread.start()

    # -- public API (thread-safe) ------------------------------------------
    def set_doc(self, chunks: list[Chunk], namespace: str, voice: str = "", position: int = 0) -> None:
        with self._cond:
            self._chunks = list(chunks)
            self._namespace = namespace
            self._voice = voice
            self._cids = [chunk_id(namespace, c.text) for c in chunks]
            self._position = position
            self._requests.clear()
            self._attempts.clear()
            self._failed.clear()
            self._cond.notify()

    def set_position(self, idx: int) -> None:
        with self._cond:
            self._position = idx
            self._cond.notify()

    def request(self, cid: str) -> threading.Event:
        with self._cond:
            event = self._events.setdefault(cid, threading.Event())
            if self.path(cid).exists():
                event.set()
                return event
            event.clear()
            self._failed.discard(cid)
            self._attempts.pop(cid, None)
            if cid not in self._requests:
                self._requests.append(cid)
            self._cond.notify()
            return event

    def path(self, cid: str) -> Path:
        return self.cache_dir / f"{cid}.wav"

    @property
    def speed(self) -> float:
        """Last measured generation speed, x realtime (0 until first chunk)."""
        return self._speed

    def status(self) -> dict:
        with self._cond:
            cids, failed, blocked = list(self._cids), set(self._failed), self._blocked
        sr = self._engine.sample_rate
        ready, durations = [], {}
        for c in cids:
            try:
                size = self.path(c).stat().st_size
            except OSError:
                continue
            ready.append(c)
            # PCM_16 mono behind a 44-byte WAV header
            durations[c] = max(0, size - 44) / (sr * 2)
        return {
            "ready": ready,
            "failed": [c for c in cids if c in failed],
            "durations": durations,
            "blocked": blocked,
        }

    # -- worker loop ---------------------------------------------------------
    def _pick(self, exclude=frozenset()):
        """Under lock: (cid, text, urgent) to generate next, or None.

        `exclude` holds cids already claimed by the batch being assembled.
        """
        by_id = dict(zip(self._cids, (c.text for c in self._chunks)))
        for cid in self._requests:
            if (cid in by_id and cid not in exclude
                    and not self.path(cid).exists()
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, by_id[cid], True
        self._requests = [c for c in self._requests
                          if c in by_id and not self.path(c).exists()
                          and self._attempts.get(c, 0) < MAX_ATTEMPTS]
        end, seconds = self._position, 0.0
        while (end < len(self._cids)
               and end - self._position < LOOKAHEAD_MAX_CHUNKS
               and seconds < LOOKAHEAD_SECONDS):
            seconds += len(self._chunks[end].text) / CHARS_PER_SECOND
            end += 1
        for idx in range(self._position, end):
            cid = self._cids[idx]
            if (not self.path(cid).exists() and cid not in self._failed
                    and cid not in exclude
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                return cid, self._chunks[idx].text, False
        probing = self._speed < self._fill_min_speed
        if probing:
            now = time.monotonic()
            if now - self._last_fill_probe < self._fill_probe_interval:
                return None
        est_bytes_per_char = self._engine.sample_rate * 2 / CHARS_PER_SECOND
        spent = 0.0
        for idx in chain(range(self._position, len(self._cids)),
                         range(0, self._position)):
            spent += len(self._chunks[idx].text) * est_bytes_per_char
            if spent > FILL_BUDGET_BYTES:
                break
            cid = self._cids[idx]
            if (not self.path(cid).exists() and cid not in self._failed
                    and cid not in exclude
                    and self._attempts.get(cid, 0) < MAX_ATTEMPTS):
                if probing:
                    self._last_fill_probe = now
                return cid, self._chunks[idx].text, False
        return None

    def _pick_batch(self, limit: int):
        """Under lock: ([(cid, text), ...], urgent) or None.

        An urgent chunk is returned alone: somebody is waiting on it, and a
        wide batch would make them wait for its slowest member too.
        """
        first = self._pick()
        if first is None:
            return None
        cid, text, urgent = first
        jobs = [(cid, text)]
        if urgent or limit <= 1:
            return jobs, urgent
        claimed = {cid}
        while len(jobs) < limit:
            nxt = self._pick(exclude=claimed)
            if nxt is None or nxt[2]:      # nothing left, or an urgent arrived
                break
            jobs.append((nxt[0], nxt[1]))
            claimed.add(nxt[0])
        return jobs, False

    def _write(self, cid: str, audio, sr: int) -> None:
        tmp = self.path(cid).with_suffix(".tmp")
        sf.write(tmp, audio, sr, format="WAV", subtype="PCM_16")
        tmp.rename(self.path(cid))

    def _settle(self, cid: str) -> None:
        """Under lock: a chunk landed."""
        self._attempts.pop(cid, None)
        self._blocked = None
        if cid in self._events:
            self._events[cid].set()

    def _retry_individually(self, jobs, voice) -> None:
        """A batch call died. Re-run its items one at a time so a single bad
        chunk cannot fail the others that happened to share its batch."""
        for cid, text in jobs:
            try:
                audio = self._engine.synthesize(text, voice)
                self._write(cid, audio, self._engine.sample_rate)
                with self._cond:
                    self._settle(cid)
            except EngineUnavailable as exc:
                with self._cond:
                    self._blocked = str(exc)
                    self._attempts[cid] = self._attempts.get(cid, 1) - 1
                return
            except Exception:
                log.exception("chunk %s failed (attempt %d)", cid[:8],
                              self._attempts.get(cid, 0))
                with self._cond:
                    if self._attempts.get(cid, 0) >= MAX_ATTEMPTS:
                        self._failed.add(cid)
        self._enforce_cache_cap()

    def _run(self):
        while True:
            with self._cond:
                picked = self._pick_batch(self._engine.max_batch)
                if picked is None:
                    self._cond.wait(timeout=1.0)
                    continue
                jobs, urgent = picked
                voice = self._voice
                for cid, _ in jobs:
                    self._attempts[cid] = self._attempts.get(cid, 0) + 1
            try:
                sr = self._engine.sample_rate
                start = time.monotonic()
                audio = self._engine.synthesize_many([t for _, t in jobs], voice,
                                                     urgent=urgent)
                wall = time.monotonic() - start
                for (cid, _), a in zip(jobs, audio):
                    self._write(cid, a, sr)
                self._enforce_cache_cap()
                total = sum(len(a) for a in audio)
                with self._cond:
                    # x-realtime of the batch as a whole: that is the rate the
                    # reader is actually fed at.
                    if wall >= 0.3 and total >= sr:
                        self._speed = (total / sr) / wall
                    for cid, _ in jobs:
                        self._settle(cid)
            except EngineUnavailable as exc:
                with self._cond:
                    self._blocked = str(exc)
                    for cid, _ in jobs:
                        self._attempts[cid] = self._attempts.get(cid, 1) - 1  # not an attempt
                    self._cond.wait(timeout=self._unavailable_wait)
            except Exception:
                if len(jobs) > 1:
                    self._retry_individually(jobs, voice)
                    continue
                cid = jobs[0][0]
                log.exception("chunk %s failed (attempt %d)", cid[:8], self._attempts.get(cid, 0))
                with self._cond:
                    if self._attempts.get(cid, 0) >= MAX_ATTEMPTS:
                        self._failed.add(cid)

    def _enforce_cache_cap(self):
        wavs = sorted(self.cache_dir.glob("*.wav"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in wavs)
        while total > CACHE_CAP_BYTES and wavs:
            victim = wavs.pop(0)
            total -= victim.stat().st_size
            victim.unlink(missing_ok=True)
