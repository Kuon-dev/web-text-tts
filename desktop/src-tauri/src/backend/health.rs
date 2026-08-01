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
    /// False in attach mode: we did not spawn it, so we must not kill it.
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

fn emit(app: &AppHandle, state: BackendState) {
    if let Ok(mut slot) = app.state::<Arc<BackendHandle>>().state.lock() {
        *slot = Some(state.clone());
    }
    let _ = app.emit("backend://state", state);
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
        st.owned = false;
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
                last_err = format!("spawn failed ({}): {e}", spec.program);
                continue;
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
                st.owned = true;
                emit(app, st);
                watch_for_exit(app.clone());
                return Ok(());
            }
            Err(e) => {
                last_err = e;
                if let Ok(mut slot) = app.state::<Arc<BackendHandle>>().child.lock() {
                    if let Some(c) = slot.as_mut() {
                        c.kill_tree();
                    }
                    *slot = None;
                }
                // Only a bind race is worth retrying; a bad interpreter would
                // spin forever.
                if attempt + 1 < SPAWN_ATTEMPTS && last_err.contains("exited") {
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
