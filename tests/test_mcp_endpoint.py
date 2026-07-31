import json

import pytest

pytest.importorskip("mcp")

import httpx

from server import create_app
from tests.test_server import FakeManager, FakeWorker

HEADERS = {"content-type": "application/json",
           "accept": "application/json, text/event-stream"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "test", "version": "1"}}}


def rpc(method, params=None, id=1):
    return {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def app(tmp_path):
    (tmp_path / "novel.txt").write_text("First line.\n\nSecond line.")
    return create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=FakeManager())


@pytest.mark.anyio
async def test_initialize_list_tools_and_load_text(app):
    transport = httpx.ASGITransport(app=app)
    # The SDK auto-enables DNS-rebinding protection for 127.0.0.1, so the Host
    # header needs a port to match its "127.0.0.1:*" allowlist.
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            r = await c.post("/mcp", json=INIT, headers=HEADERS)
            assert r.status_code == 200

            r = await c.post("/mcp", json=rpc("tools/list", id=2), headers=HEADERS)
            names = {t["name"] for t in r.json()["result"]["tools"]}
            assert names == {"fetch_page", "load_text", "append_text", "get_status"}

            r = await c.post("/mcp", json=rpc(
                "tools/call", {"name": "load_text", "arguments": {"text": "Hello there."}}, id=3),
                headers=HEADERS)
            result = r.json()["result"]
            assert result.get("isError") is not True
            payload = json.loads(result["content"][0]["text"])
            assert payload["chunks"] == 1

            r = await c.post("/mcp", json=rpc(
                "tools/call", {"name": "get_status", "arguments": {}}, id=4), headers=HEADERS)
            payload = json.loads(r.json()["result"]["content"][0]["text"])
            assert payload["chunks"] == 1
            assert payload["current_text"] == "Hello there."


@pytest.mark.anyio
async def test_a_failing_tool_comes_back_as_a_tool_error(app):
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            await c.post("/mcp", json=INIT, headers=HEADERS)
            r = await c.post("/mcp", json=rpc(
                "tools/call", {"name": "fetch_page", "arguments": {"url": "file:///etc/passwd"}},
                id=2), headers=HEADERS)
            result = r.json()["result"]
            assert result["isError"] is True
            assert "http" in result["content"][0]["text"]


def test_existing_api_still_works(app):
    from fastapi.testclient import TestClient
    with TestClient(app) as client:
        assert client.get("/api/doc").status_code == 200
