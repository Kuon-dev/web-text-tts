use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::discover::{http_get_json, pick_free_port, probe, Probe};
use super::launch::build_launch_spec;
use super::supervise::{BackendChild, LogLine};
use crate::settings::DesktopSettings;
use crate::window;

/// A cold start can include a torch import, a 313MB Kokoro download, or a
/// ~1.8GB Qwen3 variant. Minutes, not seconds.
const READY_DEADLINE: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const SPAWN_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendState {
    pub phase: String,
    pub base: Option<String>,
    pub elapsed_s: u64,
    pub message: Option<String>,
    pub log_tail: Vec<LogLine>,
    /// True exactly when `handle.child` currently holds a child this app
    /// spawned (always false in attach mode, since that path never
    /// populates the slot). Always stamped by `emit`/`currently_owned`
    /// right before the state goes out over the wire - setting this field
    /// on a `BackendState` before it reaches `emit` has no effect, so no
    /// call site needs to set it by hand.
    pub owned: bool,
}

impl BackendState {
    fn phase(phase: &str) -> Self {
        Self {
            phase: phase.to_string(),
            base: None,
            elapsed_s: 0,
            message: None,
            log_tail: vec![],
            owned: false,
        }
    }
}

#[derive(Default)]
pub struct BackendHandle {
    pub child: Mutex<Option<BackendChild>>,
    pub state: Mutex<Option<BackendState>>,
}

fn emit(app: &AppHandle, mut state: BackendState) {
    let handle = app.state::<Arc<BackendHandle>>();
    // Stamp ownership here, once, from the child slot itself rather than
    // trust each call site to set it correctly. `BackendChild` can only be
    // constructed by `BackendChild::spawn` (see supervise.rs - its `child`
    // field is private, there is no other constructor), so `handle.child`
    // holding `Some` always means WE spawned it; attach mode never
    // populates this slot at all. That makes this the one place the value
    // can be derived instead of threaded through every phase transition -
    // covers `spawning`/`waiting`/`ready` (previously all defaulted to
    // `false` for the entire, possibly 300s, window before `wait_ready`
    // succeeded) without a value that can drift out of sync with reality.
    state.owned = currently_owned(&handle);
    if let Ok(mut slot) = handle.state.lock() {
        *slot = Some(state.clone());
    }
    let _ = app.emit("backend://state", state);
}

/// True exactly when `handle.child` currently holds a child we spawned.
/// Pulled out of `emit` so it is unit-testable without a live `AppHandle`.
fn currently_owned(handle: &BackendHandle) -> bool {
    handle.child.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Full lifecycle. Runs on a worker thread so it never blocks the UI.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(message) = run(&app) {
            let mut failed = BackendState::phase("failed");
            failed.message = Some(message);
            failed.log_tail = current_tail(&app, 20);
            emit(&app, failed);
        }
    });
}

fn current_tail(app: &AppHandle, n: usize) -> Vec<LogLine> {
    app.state::<Arc<BackendHandle>>()
        .child
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.log_tail(n)))
        .unwrap_or_default()
}

fn run(app: &AppHandle) -> Result<(), String> {
    emit(app, BackendState::phase("discovering"));
    let settings = DesktopSettings::load(app);
    let dev = cfg!(debug_assertions);

    // 1. Attach to an existing novel-tts rather than racing it on state.json.
    if probe(settings.port) == Probe::NovelTts {
        let base = format!("http://127.0.0.1:{}", settings.port);
        let mut st = BackendState::phase("attached");
        st.base = Some(base.clone());
        st.message = Some("attached to a server started elsewhere".into());
        publish(app, &base)?;
        emit(app, st);
        return Ok(());
    }

    // 2. Otherwise pick a port we can actually have.
    let mut last_err = String::new();
    for attempt in 0..SPAWN_ATTEMPTS {
        let port = if probe(settings.port) == Probe::Free {
            settings.port
        } else {
            pick_free_port().map_err(|e| format!("no free port: {e}"))?
        };

        emit(app, BackendState::phase("spawning"));
        let spec = build_launch_spec(&settings, port, dev)?;
        let child = match BackendChild::spawn(&spec) {
            Ok(c) => c,
            Err(e) => {
                // A `Command::spawn` failure is an OS-level exec failure -
                // bad program path, EACCES on a non-executable interpreter,
                // ENOEXEC on the wrong architecture, ... - not a port bind
                // race (the bind happens inside the child via uvicorn,
                // well after exec already succeeded; see
                // `looks_like_a_bind_race` below for that case). Those exec
                // failures are deterministic - the same interpreter would
                // fail the same way on every attempt - so only `Interrupted`
                // (EINTR), the one genuinely transient exec-time failure, is
                // worth retrying; anything else (confirmed empirically:
                // `PermissionDenied` for an existing-but-non-executable
                // interpreter) surfaces on the failure screen immediately
                // instead of burning the retry budget.
                let transient = e.kind() == std::io::ErrorKind::Interrupted;
                last_err = format!("spawn failed ({}): {e}", spec.program);
                if attempt + 1 < SPAWN_ATTEMPTS && transient {
                    continue;
                }
                break;
            }
        };
        {
            let handle = app.state::<Arc<BackendHandle>>();
            *handle.child.lock().map_err(|_| "state poisoned")? = Some(child);
        }

        match wait_ready(app, port) {
            Ok(()) => {
                let base = format!("http://127.0.0.1:{port}");
                publish(app, &base)?;
                let mut st = BackendState::phase("ready");
                st.base = Some(base);
                emit(app, st);
                watch_for_exit(app.clone());
                return Ok(());
            }
            Err(e) => {
                last_err = e;
                let mut tail = Vec::new();
                if let Ok(mut slot) = app.state::<Arc<BackendHandle>>().child.lock() {
                    if let Some(c) = slot.as_mut() {
                        tail = c.log_tail(40);
                        c.kill_tree();
                    }
                    *slot = None;
                }
                // Retry only when the captured output actually shows
                // uvicorn/asyncio's own bind-failure signature - confirmed,
                // not guessed: reproduced a real bind race against this
                // repo's server.py (see `looks_like_a_bind_race`) rather
                // than inferring "a bind race" from the shape of the error
                // string. A `wait_ready` failure whose message merely
                // *contains* "exited" (the old heuristic) is equally true
                // of an ImportError - that must fail fast after one
                // attempt, not be retried twice more for nothing.
                if attempt + 1 < SPAWN_ATTEMPTS && looks_like_a_bind_race(&tail) {
                    continue;
                }
                break;
            }
        }
    }
    Err(last_err)
}

fn wait_ready(app: &AppHandle, port: u16) -> Result<(), String> {
    let started = Instant::now();
    loop {
        // A child that already died will never become ready.
        {
            let handle = app.state::<Arc<BackendHandle>>();
            let mut slot = handle.child.lock().map_err(|_| "state poisoned")?;
            if let Some(child) = slot.as_mut() {
                if let Some(status) = child.try_wait() {
                    return Err(format!("backend exited early ({status})"));
                }
            }
        }
        if http_get_json(port, "/api/engines", Duration::from_millis(1500)).is_ok() {
            return Ok(());
        }
        let elapsed = started.elapsed();
        if elapsed > READY_DEADLINE {
            return Err(format!(
                "backend did not become ready within {}s",
                READY_DEADLINE.as_secs()
            ));
        }
        let mut st = BackendState::phase("waiting");
        st.elapsed_s = elapsed.as_secs();
        st.log_tail = current_tail(app, 20);
        emit(app, st);
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Whether captured child output shows uvicorn/asyncio's own bind-failure
/// signature, as opposed to some other reason the child exited quickly
/// (e.g. an `ImportError`). POSIX (macOS/Linux, and Linux-inside-WSL, since
/// WSL mode still runs the interpreter under a Linux kernel) phrases this
/// as "address already in use"; native Windows Python's `OSError` uses
/// "WinError 10048" instead.
///
/// The POSIX branch is verified against this repo's actual server.py:
/// racing two instances for the same port produced
/// `ERROR:    [Errno 48] error while attempting to bind on address
/// ('127.0.0.1', 8765): address already in use` on macOS. The Windows
/// branch is matched by inspection of the well-known WinError code only -
/// unverified on that platform, same caveat as the rest of this crate's
/// Windows-only paths.
fn looks_like_a_bind_race(log_tail: &[LogLine]) -> bool {
    log_tail.iter().any(|l| {
        let t = l.text.to_ascii_lowercase();
        t.contains("address already in use") || t.contains("winerror 10048")
    })
}

fn publish(app: &AppHandle, base: &str) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    window::inject_api_base(&win, base).map_err(|e| e.to_string())
}

/// Surface an unexpected death. Deliberately does NOT respawn in a loop: an
/// ImportError would spin forever.
fn watch_for_exit(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let handle = app.state::<Arc<BackendHandle>>();
        let dead = {
            let mut slot = match handle.child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match slot.as_mut() {
                Some(child) => child.try_wait().is_some(),
                None => return,
            }
        };
        if dead {
            let mut st = BackendState::phase("exited");
            st.message = Some("the backend process stopped".into());
            st.log_tail = current_tail(&app, 20);
            emit(&app, st);
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::launch::LaunchSpec;

    /// A trivial, fast child - mirrors supervise.rs's own test fixtures.
    /// None of these tests need a live `AppHandle`: `currently_owned` and
    /// `looks_like_a_bind_race` are both pure functions over a
    /// `BackendHandle`/`&[LogLine]`, deliberately factored out of `emit`
    /// and the retry decisions so the state-machine logic they gate is
    /// testable without standing up a full Tauri app.
    fn echo_spec(script: &str) -> LaunchSpec {
        LaunchSpec {
            program: if cfg!(windows) { "cmd".into() } else { "sh".into() },
            args: if cfg!(windows) {
                vec!["/C".into(), script.into()]
            } else {
                vec!["-c".into(), script.into()]
            },
            cwd: None,
            env: vec![],
        }
    }

    #[test]
    fn currently_owned_reflects_the_child_slot_not_a_hand_set_flag() {
        let handle = BackendHandle::default();
        assert!(!currently_owned(&handle), "nothing spawned yet: not owned");

        let child = BackendChild::spawn(&echo_spec("echo hi")).expect("spawn a trivial child");
        *handle.child.lock().unwrap() = Some(child);
        assert!(
            currently_owned(&handle),
            "a child we spawned occupies the slot: owned"
        );

        // Mirrors the wait_ready-failure cleanup path in `run`: kill, then
        // clear the slot. Ownership must drop with it, in the same beat -
        // this is exactly the "spawning"/"waiting" window Finding 1 was
        // about: nothing here should be able to go stale.
        if let Some(c) = handle.child.lock().unwrap().as_mut() {
            c.kill_tree();
        }
        *handle.child.lock().unwrap() = None;
        assert!(
            !currently_owned(&handle),
            "slot cleared: no longer owned"
        );
    }

    #[test]
    fn a_fresh_handle_never_looks_owned() {
        // Attach mode never touches `handle.child` at all for the entire
        // run - confirm the structural guarantee `emit`'s fix relies on:
        // an empty handle (BackendHandle::default(), and what attach mode
        // leaves behind) always reports unowned.
        assert!(!currently_owned(&BackendHandle::default()));
    }

    #[test]
    fn bind_race_signature_matches_the_real_uvicorn_message() {
        // Captured verbatim by actually racing two `server.py` instances
        // for the same port on macOS - not a guessed string.
        let tail = vec![
            LogLine {
                stream: "stdout".into(),
                text: "2026-08-02 01:42:52,129 INFO Kokoro gpu_available=False mode=auto".into(),
            },
            LogLine {
                stream: "stdout".into(),
                text: "2026-08-02 01:42:52,440 INFO novel-tts ready: http://127.0.0.1:8765".into(),
            },
            LogLine {
                stream: "stderr".into(),
                text: "ERROR:    [Errno 48] error while attempting to bind on address \
                        ('127.0.0.1', 8765): address already in use"
                    .into(),
            },
        ];
        assert!(looks_like_a_bind_race(&tail));
    }

    #[test]
    fn an_import_error_does_not_look_like_a_bind_race() {
        // The exact failure mode Finding 2 was about: a crash that also
        // exits quickly, but is not a port race and must not be retried.
        let tail = vec![
            LogLine {
                stream: "stderr".into(),
                text: "Traceback (most recent call last):".into(),
            },
            LogLine {
                stream: "stderr".into(),
                text: "ModuleNotFoundError: No module named 'torch'".into(),
            },
        ];
        assert!(!looks_like_a_bind_race(&tail));
    }

    #[test]
    fn windows_bind_failure_signature_is_recognized_by_inspection() {
        // Unverified on real Windows - matched by inspection of the
        // well-known WinError code for this failure, not exercised there.
        let tail = vec![LogLine {
            stream: "stderr".into(),
            text: "OSError: [WinError 10048] Only one usage of each socket address \
                    (protocol/network address/port) is normally permitted"
                .into(),
        }];
        assert!(looks_like_a_bind_race(&tail));
    }

    #[test]
    fn an_empty_tail_does_not_look_like_a_bind_race() {
        assert!(!looks_like_a_bind_race(&[]));
    }
}
