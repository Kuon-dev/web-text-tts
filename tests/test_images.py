import hashlib
import struct

from chunker import chunk_text, doc_images
from images import ImageStore, sniff
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
