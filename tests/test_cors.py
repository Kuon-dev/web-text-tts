"""CORS for the Tauri desktop origin (spec 2026-08-01-desktop-tauri-design)."""
from fastapi.testclient import TestClient

from server import create_app
from tests.test_server import FakeManager, FakeWorker

TAURI = "tauri://localhost"


def _client(tmp_path, **kw):
    worker = FakeWorker(tmp_path / "cache")
    return TestClient(create_app(tmp_path, worker, manager=FakeManager(), **kw))


def test_desktop_origin_gets_allow_origin(tmp_path):
    r = _client(tmp_path).get("/api/engines", headers={"Origin": TAURI})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == TAURI


def test_preflight_allows_delete(tmp_path):
    """deleteClone and removeWallpaper use DELETE; FastAPI has no OPTIONS route
    for those paths, so without CORSMiddleware installing the preflight
    responder they would 405."""
    r = _client(tmp_path).options(
        "/api/wallpaper",
        headers={"Origin": TAURI,
                 "Access-Control-Request-Method": "DELETE"},
    )
    assert r.status_code == 200
    assert "DELETE" in r.headers["access-control-allow-methods"]


def test_preflight_allows_json_content_type(tmp_path):
    """Every api(path, body) call sets Content-Type: application/json."""
    r = _client(tmp_path).options(
        "/api/state",
        headers={"Origin": TAURI,
                 "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "content-type"},
    )
    assert r.status_code == 200


def test_localhost_dev_server_origin_allowed(tmp_path):
    """`tauri dev` serves the UI from http://localhost:1420."""
    r = _client(tmp_path).get(
        "/api/engines", headers={"Origin": "http://localhost:1420"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:1420"


def test_extra_origin_can_be_injected(tmp_path):
    r = _client(tmp_path, cors_origins=["https://example.test"]).get(
        "/api/engines", headers={"Origin": "https://example.test"})
    assert r.headers["access-control-allow-origin"] == "https://example.test"


def test_no_credentials_header(tmp_path):
    """Nothing in the client sends cookies; allow_credentials must stay off."""
    r = _client(tmp_path).get("/api/engines", headers={"Origin": TAURI})
    assert "access-control-allow-credentials" not in r.headers


def test_same_origin_web_app_unaffected(tmp_path):
    """No Origin header (the web app's own requests) still works normally."""
    r = _client(tmp_path).get("/api/engines")
    assert r.status_code == 200
