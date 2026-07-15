from images import MAX_IMAGE_BYTES
from tests.test_images import jpeg_bytes, png_bytes
from tests.test_server import make_client


def test_wallpaper_roundtrip(tmp_path):
    client, _ = make_client(tmp_path)
    data = png_bytes(2560, 1440)

    up = client.post("/api/wallpaper", content=data)
    assert up.status_code == 200
    info = up.json()["wallpaper"]
    assert (info["w"], info["h"], info["format"]) == (2560, 1440, "png")

    assert client.get("/api/wallpaper/info").json()["wallpaper"] == info

    got = client.get("/api/wallpaper")
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/png"
    assert got.content == data


def test_wallpaper_replace_changes_id(tmp_path):
    client, _ = make_client(tmp_path)
    first = client.post("/api/wallpaper", content=png_bytes(100, 100)).json()["wallpaper"]
    second = client.post("/api/wallpaper", content=jpeg_bytes(800, 600)).json()["wallpaper"]
    assert first["id"] != second["id"]
    assert second["format"] == "jpeg"
    assert client.get("/api/wallpaper").headers["content-type"] == "image/jpeg"


def test_wallpaper_delete(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/wallpaper", content=png_bytes())
    resp = client.request("DELETE", "/api/wallpaper")
    assert resp.status_code == 200 and resp.json()["wallpaper"] is None
    assert client.get("/api/wallpaper").status_code == 404
    assert client.get("/api/wallpaper/info").json()["wallpaper"] is None
    # deleting again is harmless
    assert client.request("DELETE", "/api/wallpaper").status_code == 200


def test_wallpaper_absent_by_default(tmp_path):
    client, _ = make_client(tmp_path)
    assert client.get("/api/wallpaper/info").json() == {"wallpaper": None}
    assert client.get("/api/wallpaper").status_code == 404


def test_wallpaper_rejects_junk_and_oversized(tmp_path):
    client, _ = make_client(tmp_path)
    assert client.post("/api/wallpaper", content=b"not an image").status_code == 400
    huge = png_bytes() + b"\x00" * MAX_IMAGE_BYTES
    assert client.post("/api/wallpaper", content=huge).status_code == 400
    # nothing got stored by the failed uploads
    assert client.get("/api/wallpaper/info").json()["wallpaper"] is None


def test_wallpaper_survives_restart(tmp_path):
    client, _ = make_client(tmp_path)
    data = png_bytes(1920, 1080)
    wid = client.post("/api/wallpaper", content=data).json()["wallpaper"]["id"]
    # a fresh app over the same data dir serves the same wallpaper
    client2, _ = make_client(tmp_path)
    assert client2.get("/api/wallpaper/info").json()["wallpaper"]["id"] == wid
    assert client2.get("/api/wallpaper").content == data
