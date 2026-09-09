import contextlib
import hashlib
import http.server
import struct
import threading

import pytest

from chunker import chunk_text, doc_images
from images import ImageError, ImageStore, sniff
from tests.test_server import make_client


def png_bytes(w=1353, h=1920):
    ihdr = struct.pack(">II", w, h) + b"\x08\x06\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\x00" * 4


def jpeg_bytes(w=800, h=600):
    sof = struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", h, w) + b"\x03" + b"\x00" * 9
    return b"\xff\xd8\xff\xc0" + sof + b"\xff\xd9"


def gif_bytes(w=64, h=32):
    return b"GIF89a" + struct.pack("<HH", w, h) + b"\x00\x00\x00"


def marker(data: bytes) -> str:
    return f"[img:{hashlib.sha1(data).hexdigest()}]"


# --- sniffing ---

def test_sniff_formats():
    assert sniff(png_bytes(1353, 1920)) == ("png", 1353, 1920)
    assert sniff(jpeg_bytes(800, 600)) == ("jpeg", 800, 600)
    assert sniff(gif_bytes(64, 32)) == ("gif", 64, 32)
    assert sniff(b"not an image at all") is None


# --- chunker markers ---

def test_marker_paragraph_not_spoken():
    text = "First line.\n" + marker(png_bytes()) + "\nSecond line."
    chunks = chunk_text(text)
    assert [c.text for c in chunks] == ["First line.", "Second line."]
    assert [c.para for c in chunks] == [0, 2]


def test_doc_images_positions():
    data = png_bytes()
    text = marker(data) + "\nStory begins.\n" + marker(data)
    refs = doc_images(text)
    assert [(r.para) for r in refs] == [0, 2]
    assert all(r.id == hashlib.sha1(data).hexdigest() for r in refs)


def test_inline_marker_is_plain_text():
    # markers must be on their own line; embedded ones stay spoken text
    text = "Look at [img:" + "a" * 40 + "] this."
    assert doc_images(text) == []
    assert len(chunk_text(text)) == 1


# --- store ---

def test_store_put_meta_roundtrip(tmp_path):
    store = ImageStore(tmp_path / "images")
    info = store.put(png_bytes(100, 50))
    assert (info["w"], info["h"], info["format"]) == (100, 50, "png")
    fresh = ImageStore(tmp_path / "images")  # re-sniffs from disk
    assert fresh.meta(info["id"]) == info
    assert fresh.media_type(info["id"]) == "image/png"


# --- endpoints ---

def test_image_upload_doc_and_serve(tmp_path):
    client, _ = make_client(tmp_path)
    data = png_bytes(1353, 1920)

    up = client.post("/api/image", content=data)
    assert up.status_code == 200
    iid = up.json()["id"]
    assert iid == hashlib.sha1(data).hexdigest()

    doc = client.post("/api/doc", json={"text": f"Before.\n[img:{iid}]\nAfter."}).json()
    assert doc["images"] == [{"id": iid, "para": 1, "w": 1353, "h": 1920}]
    assert [c["text"] for c in doc["chunks"]] == ["Before.", "After."]

    got = client.get(f"/api/image/{iid}")
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/png"
    assert got.content == data


def test_image_upload_rejects_junk(tmp_path):
    client, _ = make_client(tmp_path)
    assert client.post("/api/image", content=b"junk").status_code == 400
    assert client.get("/api/image/" + "0" * 40).status_code == 404
    assert client.get("/api/image/nothex").status_code == 404


def test_doc_skips_missing_image_files(tmp_path):
    client, _ = make_client(tmp_path)
    doc = client.post("/api/doc", json={"text": "Hi.\n[img:" + "b" * 40 + "]"}).json()
    assert doc["images"] == []
    assert [c["text"] for c in doc["chunks"]] == ["Hi."]


# --- fetch(): bearer auth for a private image host -------------------------
#
# Chapter illustrations can live behind a token (the novel-scrape ingest
# service serves /image/<sha256> that way). The token must reach that host and
# ONLY that host: a chapter's other images come from untrusted sites, and
# posting a bearer token to one of those would hand it over.

class _ImgServer(http.server.BaseHTTPRequestHandler):
    body = b""
    token = None
    seen: list = []

    def do_GET(self):
        cls = type(self)
        cls.seen.append(self.headers.get("Authorization"))
        if cls.token and self.headers.get("Authorization") != f"Bearer {cls.token}":
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(cls.body)))
        self.end_headers()
        self.wfile.write(cls.body)

    def log_message(self, *args):
        pass


@contextlib.contextmanager
def image_server(body: bytes, token: str | None = None):
    _ImgServer.body, _ImgServer.token, _ImgServer.seen = body, token, []
    srv = http.server.HTTPServer(("127.0.0.1", 0), _ImgServer)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv.server_port
    finally:
        srv.shutdown()


def test_fetch_sends_no_authorization_by_default(tmp_path):
    data = png_bytes()
    store = ImageStore(tmp_path / "images")
    with image_server(data) as port:
        assert store.fetch(f"http://127.0.0.1:{port}/image/x")["id"] == hashlib.sha1(data).hexdigest()
    assert _ImgServer.seen == [None]


def test_fetch_sends_the_bearer_token_to_an_allowlisted_host(tmp_path):
    data = png_bytes()
    with image_server(data, token="s3cret") as port:
        store = ImageStore(tmp_path / "images", token="s3cret", token_hosts=[f"127.0.0.1:{port}"])
        assert store.fetch(f"http://127.0.0.1:{port}/image/x")["id"] == hashlib.sha1(data).hexdigest()
    assert _ImgServer.seen == ["Bearer s3cret"]


def test_fetch_withholds_the_token_from_every_other_host(tmp_path):
    data = png_bytes()
    with image_server(data, token="s3cret") as port:
        # Token is scoped to localhost:<port>; the same server reached as
        # 127.0.0.1:<port> is a different host and must not receive it.
        store = ImageStore(tmp_path / "images", token="s3cret", token_hosts=[f"localhost:{port}"])
        with pytest.raises(ImageError):
            store.fetch(f"http://127.0.0.1:{port}/image/x")
    assert _ImgServer.seen == [None]


def test_fetch_scopes_the_token_by_port_too(tmp_path):
    data = png_bytes()
    with image_server(data, token="s3cret") as port:
        store = ImageStore(tmp_path / "images", token="s3cret", token_hosts=["127.0.0.1:9"])
        with pytest.raises(ImageError):
            store.fetch(f"http://127.0.0.1:{port}/image/x")
    assert _ImgServer.seen == [None]


def test_image_token_is_configured_from_the_environment(tmp_path, monkeypatch):
    """The deployed server reads the private host's token out of its env."""
    data = png_bytes()
    with image_server(data, token="env-tok") as port:
        monkeypatch.setenv("NOVEL_TTS_IMAGE_TOKEN", "env-tok")
        monkeypatch.setenv("NOVEL_TTS_IMAGE_TOKEN_HOSTS", f"localhost:{port}, 127.0.0.1:{port}")
        client, _ = make_client(tmp_path)
        resp = client.post("/api/image/fetch", json={"url": f"http://127.0.0.1:{port}/image/x"})
    assert resp.status_code == 200
    assert resp.json()["id"] == hashlib.sha1(data).hexdigest()
    assert _ImgServer.seen == ["Bearer env-tok"]
