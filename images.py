"""Content-addressed illustration store: sniffing, fetching, pruning."""
import hashlib
import logging
import struct
import urllib.request
from pathlib import Path

log = logging.getLogger("novel-tts")

# Generous caps: the server is local-only, so an upload just costs a brief
# in-memory spike — no reason to reject a big lossless PNG wallpaper.
MAX_IMAGE_BYTES = 200 * 1024 * 1024
MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024
FETCH_TIMEOUT = 30.0
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) novel-tts/1.0"

MEDIA_TYPES = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


def sniff(data: bytes) -> tuple[str, int, int] | None:
    """(format, width, height) for png/jpeg/gif/webp, else None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack(">II", data[16:24])
        return "png", w, h
    if data[:2] == b"\xff\xd8":
        return _sniff_jpeg(data)
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        w, h = struct.unpack("<HH", data[6:10])
        return "gif", w, h
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return _sniff_webp(data)
    return None


def _sniff_jpeg(data: bytes) -> tuple[str, int, int] | None:
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return "jpeg", w, h
        i += 2 + length
    return None


def _sniff_webp(data: bytes) -> tuple[str, int, int] | None:
    kind = data[12:16]
    if kind == b"VP8X" and len(data) >= 30:
        w = int.from_bytes(data[24:27], "little") + 1
        h = int.from_bytes(data[27:30], "little") + 1
        return "webp", w, h
    if kind == b"VP8 " and len(data) >= 30:
        w, h = struct.unpack("<HH", data[26:30])
        return "webp", w & 0x3FFF, h & 0x3FFF
    if kind == b"VP8L" and len(data) >= 25:
        bits = int.from_bytes(data[21:25], "little")
        return "webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


class ImageError(ValueError):
    """User-facing failure (bad data, bad url, too big)."""


class ImageStore:
    """Illustrations stored as images/<sha1-of-bytes>, format sniffed on read."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._meta: dict[str, dict] = {}

    def path(self, iid: str) -> Path:
        return self.root / iid

    def put(self, data: bytes) -> dict:
        if len(data) > MAX_IMAGE_BYTES:
            raise ImageError("image too large (200MB max)")
        info = sniff(data)
        if not info:
            raise ImageError("unsupported image format (png/jpeg/gif/webp only)")
        fmt, w, h = info
        if not w or not h:
            raise ImageError("could not read image dimensions")
        iid = hashlib.sha1(data).hexdigest()
        p = self.path(iid)
        if not p.exists():
            p.write_bytes(data)
        self._meta[iid] = {"id": iid, "w": w, "h": h, "format": fmt}
        return self._meta[iid]

    def fetch(self, url: str) -> dict:
        if not url.startswith(("http://", "https://")):
            raise ImageError("only http(s) image URLs are supported")
        req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "image/*,*/*"})
        try:
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                data = resp.read(MAX_IMAGE_BYTES + 1)
        except Exception as exc:
            raise ImageError(f"download failed: {exc}") from exc
        return self.put(data)

    def meta(self, iid: str) -> dict | None:
        if iid in self._meta:
            return self._meta[iid]
        p = self.path(iid)
        if not p.exists():
            return None
        info = sniff(p.read_bytes())
        if not info:
            return None
        fmt, w, h = info
        self._meta[iid] = {"id": iid, "w": w, "h": h, "format": fmt}
        return self._meta[iid]

    def media_type(self, iid: str) -> str | None:
        m = self.meta(iid)
        return MEDIA_TYPES[m["format"]] if m else None

    def prune(self, referenced: set[str], max_bytes: int = MAX_STORE_BYTES):
        """Drop oldest unreferenced images once the store exceeds max_bytes."""
        try:
            files = [(p, p.stat()) for p in self.root.iterdir() if p.is_file()]
        except OSError:
            return
        total = sum(s.st_size for _, s in files)
        if total <= max_bytes:
            return
        for p, s in sorted(files, key=lambda e: e[1].st_mtime):
            if p.name in referenced:
                continue
            try:
                p.unlink()
                self._meta.pop(p.name, None)
                total -= s.st_size
            except OSError:
                continue
            if total <= max_bytes:
                return
