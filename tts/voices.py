"""Cloned-voice reference clips: voices/<hex>/ref.wav + meta.json (like images.py)."""
import hashlib
import io
import json
import re
import shutil
import time
from pathlib import Path

import soundfile as sf

from .base import Voice

MIN_SECONDS, MAX_SECONDS = 3.0, 30.0
_ID_RE = re.compile(r"[0-9a-f]{12}")


class CloneError(ValueError):
    pass


class CloneStore:
    def __init__(self, dir_path: Path):
        self.dir = Path(dir_path)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _dir(self, voice_id: str) -> Path:
        suffix = voice_id.removeprefix("clone:")
        if not _ID_RE.fullmatch(suffix):
            raise CloneError(f"malformed clone id: {voice_id!r}")
        return self.dir / suffix

    def add(self, data: bytes, name: str, language: str = "en") -> Voice:
        try:
            info = sf.info(io.BytesIO(data))
        except Exception:
            raise CloneError("could not decode audio (wav/flac/ogg supported)")
        seconds = info.frames / info.samplerate
        if seconds < MIN_SECONDS:
            raise CloneError(f"clip too short: need at least {MIN_SECONDS:.0f}s")
        if seconds > MAX_SECONDS:
            raise CloneError(f"clip too long: at most {MAX_SECONDS:.0f}s")
        sha = hashlib.sha1(data).hexdigest()
        vid = f"clone:{sha[:12]}"
        d = self._dir(vid)
        d.mkdir(parents=True, exist_ok=True)
        (d / "ref.wav").write_bytes(data)
        (d / "meta.json").write_text(json.dumps(
            {"name": name, "language": language, "ref_sha1": sha, "created": time.time()}))
        return Voice(id=vid, name=name, group="Cloned", language=language)

    def voices(self) -> list[Voice]:
        out = []
        for meta_path in sorted(self.dir.glob("*/meta.json")):
            meta = json.loads(meta_path.read_text())
            out.append(Voice(id=f"clone:{meta_path.parent.name}", name=meta["name"],
                             group="Cloned", language=meta["language"]))
        return out

    def has(self, voice_id: str) -> bool:
        if not voice_id.startswith("clone:"):
            return False
        try:
            return (self._dir(voice_id) / "meta.json").exists()
        except CloneError:
            return False

    def ref_path(self, voice_id: str) -> Path:
        return self._dir(voice_id) / "ref.wav"

    def fingerprint(self, voice_id: str) -> str:
        meta = json.loads((self._dir(voice_id) / "meta.json").read_text())
        return meta["ref_sha1"]

    def delete(self, voice_id: str) -> bool:
        if not self.has(voice_id):
            return False
        shutil.rmtree(self._dir(voice_id))
        return True
