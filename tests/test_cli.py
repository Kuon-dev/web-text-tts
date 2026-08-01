"""The sidecar CLI contract (spec 2026-08-01-desktop-tauri-design)."""
import server


def test_defaults_match_todays_behavior():
    a = server.build_parser().parse_args([])
    assert a.host == "127.0.0.1"
    assert a.port == 8765
    assert a.data_dir is None
    assert a.cors_origin == []
    assert a.exit_on_stdin_close is False


def test_flags_parse():
    a = server.build_parser().parse_args(
        ["--host", "0.0.0.0", "--port", "9123", "--data-dir", "/tmp/x",
         "--cors-origin", "http://localhost:1420", "--exit-on-stdin-close"])
    assert a.host == "0.0.0.0"
    assert a.port == 9123
    assert a.data_dir == "/tmp/x"
    assert a.cors_origin == ["http://localhost:1420"]
    assert a.exit_on_stdin_close is True


def test_cors_origin_repeats():
    a = server.build_parser().parse_args(
        ["--cors-origin", "a://b", "--cors-origin", "c://d"])
    assert a.cors_origin == ["a://b", "c://d"]


def test_env_overrides_default(monkeypatch):
    monkeypatch.setenv("NOVEL_TTS_PORT", "7000")
    monkeypatch.setenv("NOVEL_TTS_HOST", "0.0.0.0")
    a = server.build_parser().parse_args([])
    assert a.port == 7000
    assert a.host == "0.0.0.0"


def test_explicit_flag_beats_env(monkeypatch):
    monkeypatch.setenv("NOVEL_TTS_PORT", "7000")
    a = server.build_parser().parse_args(["--port", "8123"])
    assert a.port == 8123
