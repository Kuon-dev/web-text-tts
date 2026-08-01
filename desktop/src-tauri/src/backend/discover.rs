use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const READ_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// Nothing is listening; safe to spawn here.
    Free,
    /// A novel-tts server is listening; attach to it.
    NovelTts,
    /// Something else holds the port; move aside.
    Foreign,
}

/// Minimal blocking HTTP/1.1 GET against localhost.
///
/// Hand-rolled rather than pulling in an HTTP client: the only requests this
/// app makes are localhost JSON GETs. `Connection: close` makes uvicorn close
/// the socket after responding, so read-to-EOF terminates instead of hanging
/// on keep-alive.
pub fn http_get_json(
    port: u16,
    path: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut sock = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("connect: {e}"))?;
    sock.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    sock.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;

    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Accept: application/json\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;

    let mut raw = Vec::new();
    sock.read_to_end(&mut raw).map_err(|e| format!("read: {e}"))?;

    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "malformed response: no header terminator".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status_ok = head
        .lines()
        .next()
        .map(|l| l.contains(" 200"))
        .unwrap_or(false);
    if !status_ok {
        return Err(format!("non-200 response: {}", head.lines().next().unwrap_or("")));
    }
    serde_json::from_slice(&raw[split + 4..]).map_err(|e| format!("json: {e}"))
}

/// Classify whatever is on `port`.
///
/// GET /api/engines is the right probe: it is lock-free on the server side
/// (tts/registry.py uses importlib.util.find_spec, tts/manager.py exposes
/// engine_id as a plain property), so it cannot block behind an in-flight
/// synthesize. /api/doc and /api/voices both take st.lock; /api/audio blocks
/// for up to 30s.
pub fn probe(port: u16) -> Probe {
    let value = match http_get_json(port, "/api/engines", READ_TIMEOUT) {
        Ok(v) => v,
        Err(e) if e.starts_with("connect:") => return Probe::Free,
        Err(_) => return Probe::Foreign,
    };
    if is_novel_tts(&value) {
        Probe::NovelTts
    } else {
        Probe::Foreign
    }
}

/// Shape check. Attaching on a bare 200 would point the reader at an unrelated
/// process that merely happens to hold the port.
fn is_novel_tts(v: &serde_json::Value) -> bool {
    let has_current = v.get("current").and_then(|c| c.as_str()).is_some();
    let entries_ok = v
        .get("engines")
        .and_then(|e| e.as_array())
        .map(|arr| {
            !arr.is_empty()
                && arr.iter().all(|e| {
                    e.get("id").and_then(|i| i.as_str()).is_some()
                        && e.get("supported_modes").and_then(|m| m.as_array()).is_some()
                })
        })
        .unwrap_or(false);
    has_current && entries_ok
}

/// Ask the OS for an unused port. There is an unavoidable TOCTOU window
/// between this and the child's bind; callers retry.
pub fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// Serve one canned HTTP response and close, mimicking uvicorn's behavior
    /// when the request carries `Connection: close`.
    fn serve_once(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        port
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn nothing_listening_is_free() {
        assert!(matches!(probe(free_port()), Probe::Free));
    }

    #[test]
    fn a_novel_tts_shaped_response_is_ours() {
        let port = serve_once(
            r#"{"engines":[{"id":"kokoro","supported_modes":["auto"]}],"current":"kokoro"}"#,
        );
        assert!(matches!(probe(port), Probe::NovelTts));
    }

    #[test]
    fn a_different_json_service_is_foreign() {
        let port = serve_once(r#"{"hello":"world"}"#);
        assert!(matches!(probe(port), Probe::Foreign));
    }

    #[test]
    fn engines_without_the_expected_entry_shape_is_foreign() {
        let port = serve_once(r#"{"engines":[{"name":"x"}],"current":"x"}"#);
        assert!(matches!(probe(port), Probe::Foreign));
    }

    #[test]
    fn pick_free_port_returns_a_bindable_port() {
        let p = pick_free_port().unwrap();
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    /// Runs the real `server.py` and checks that `probe`/`http_get_json`
    /// classify it correctly. Not part of the default `cargo test` run
    /// because it shells out to Python and waits for model load; run
    /// explicitly with `cargo test -- --ignored`.
    #[test]
    #[ignore = "spawns the real server.py; run with `cargo test -- --ignored`"]
    fn probe_classifies_the_real_server_as_novel_tts() {
        use std::path::PathBuf;
        use std::process::{Child, Command, Stdio};
        use std::time::Instant;

        /// Kills the child on drop so a failing assertion still cleans up
        /// the process instead of leaking a listener on 8765.
        struct KillOnDrop(Child);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("repo root resolves");
        let python = repo_root.join(".venv311/bin/python");
        let script = repo_root.join("server.py");
        assert!(python.exists(), "expected {python:?} to exist");
        assert!(script.exists(), "expected {script:?} to exist");

        let child = Command::new(&python)
            .arg(&script)
            .current_dir(&repo_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn server.py");
        let _guard = KillOnDrop(child);

        // Model load takes real time; poll /api/engines rather than sleeping
        // a fixed duration. The first successful response also proves
        // http_get_json parses a real uvicorn response.
        let deadline = Instant::now() + Duration::from_secs(120);
        let body = loop {
            match http_get_json(8765, "/api/engines", Duration::from_millis(500)) {
                Ok(v) => break v,
                Err(e) => assert!(
                    Instant::now() < deadline,
                    "server.py did not answer /api/engines within 120s: {e}"
                ),
            }
            thread::sleep(Duration::from_millis(200));
        };

        assert!(body.get("current").and_then(|c| c.as_str()).is_some());
        assert!(body
            .get("engines")
            .and_then(|e| e.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false));

        assert!(
            matches!(probe(8765), Probe::NovelTts),
            "a real server.py must shape-check as NovelTts"
        );

        // guard drops here, killing the child before the test returns.
    }
}
