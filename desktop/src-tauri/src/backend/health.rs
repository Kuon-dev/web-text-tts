use std::sync::atomic::{AtomicUsize, Ordering};
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
    /// Generation counter. Bumped by every `start()` (including the one
    /// `restart_backend` triggers). A run captures the value at spawn time
    /// and treats it as its "am I still the current run" ticket for the
    /// rest of its life - see `current`, `store_if_current`,
    /// `cleanup_if_current` and `emit` below, which are the only things
    /// allowed to touch `child`/`state` and all gate on it. This is what
    /// makes a second Restart (or a Retry racing a slow first attempt) shut
    /// the superseded run out instead of racing it - see Finding 3.
    epoch: AtomicUsize,
}

impl BackendHandle {
    /// Bump the generation and return the new value. Called once per
    /// `start()`; `restart_backend` (commands.rs) also calls it directly,
    /// before it touches the child slot, so a thread still working under
    /// the old epoch is guaranteed to see the bump (via `current`) before
    /// restart's own kill/clear can race it - see the module doc above.
    pub fn supersede(&self) -> usize {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// True iff `epoch` is still `handle`'s current generation. Always read
/// fresh off the atomic - never cached across an await/sleep/lock boundary -
/// so nothing holds a stale "yes" past the point it stops being true.
fn current(handle: &BackendHandle, epoch: usize) -> bool {
    handle.epoch.load(Ordering::SeqCst) == epoch
}

/// Store `child` in the shared slot iff `epoch` is still current; otherwise
/// hand it straight back so the (now superseded) caller can kill it itself.
/// A superseded run's freshly spawned child never enters shared state, so no
/// one else knows it exists - killing it is that caller's job alone.
///
/// The epoch is re-checked *under the same lock* the store itself uses, so
/// this races cleanly against a concurrent `restart_backend`/`supersede`:
/// either that bump lands before this check (we see it, refuse to store),
/// or it lands after we've already stored and released the lock (in which
/// case what we stored was, at the moment we stored it, genuinely current -
/// and `restart_backend`'s own lock-guarded kill/clear will reach it next).
fn store_if_current(handle: &BackendHandle, epoch: usize, child: BackendChild) -> Option<BackendChild> {
    let Ok(mut slot) = handle.child.lock() else { return Some(child) };
    if handle.epoch.load(Ordering::SeqCst) != epoch {
        return Some(child);
    }
    *slot = Some(child);
    None
}

/// Kill and clear whatever is in the slot iff `epoch` is still current;
/// otherwise a no-op. A superseded caller must not touch the slot at all -
/// by the time it notices, either a restart already cleared it, or a newer
/// generation has stored its own child there. Same lock-guarded re-check
/// discipline as `store_if_current`.
fn cleanup_if_current(handle: &BackendHandle, epoch: usize) -> Vec<LogLine> {
    let Ok(mut slot) = handle.child.lock() else { return Vec::new() };
    if handle.epoch.load(Ordering::SeqCst) != epoch {
        return Vec::new();
    }
    let mut tail = Vec::new();
    if let Some(c) = slot.as_mut() {
        tail = c.log_tail(40);
        c.kill_tree();
    }
    *slot = None;
    tail
}

fn emit(app: &AppHandle, epoch: usize, mut state: BackendState) {
    let handle = app.state::<Arc<BackendHandle>>();
    if !current(&handle, epoch) {
        return; // superseded: must not emit, must not stamp handle.state
    }
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
    let Ok(mut slot) = handle.state.lock() else { return };
    // Re-check under the lock: a restart could have superseded us between
    // the check above and taking this lock.
    if handle.epoch.load(Ordering::SeqCst) != epoch {
        return;
    }
    *slot = Some(state.clone());
    drop(slot);
    let _ = app.emit("backend://state", state);
}

/// True exactly when `handle.child` currently holds a child we spawned.
/// Pulled out of `emit` so it is unit-testable without a live `AppHandle`,
/// and reused by `backend::teardown::shutdown_backend` as the single source
/// of truth for "is there something here to kill" - not a separately
/// tracked flag, which could go stale between the moment a child is stored
/// and the next `emit` (see Finding 3's emit-vs-store note).
pub(crate) fn currently_owned(handle: &BackendHandle) -> bool {
    handle.child.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Full lifecycle. Runs on a worker thread so it never blocks the UI.
///
/// Bumps the generation *before* spawning the worker thread (not inside
/// it): by the time this returns, any older generation's next `current`
/// check will already see the new value, no matter how that thread is
/// scheduled.
pub fn start(app: AppHandle) {
    let epoch = app.state::<Arc<BackendHandle>>().supersede();
    std::thread::spawn(move || {
        if let Err(message) = run(&app, epoch) {
            let mut failed = BackendState::phase("failed");
            failed.message = Some(message);
            failed.log_tail = current_tail(&app, 20);
            emit(&app, epoch, failed);
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

/// `epoch` is the generation this run was started under (captured once, in
/// `start`, before this function's thread even began). Every mutation of
/// shared state - `emit`, storing the child, cleaning it up - re-checks it
/// via `current`/`store_if_current`/`cleanup_if_current` and silently backs
/// off the instant it goes stale, rather than trusting the check that got us
/// into this function in the first place. See Finding 3.
fn run(app: &AppHandle, epoch: usize) -> Result<(), String> {
    emit(app, epoch, BackendState::phase("discovering"));
    let settings = DesktopSettings::load(app);
    let dev = cfg!(debug_assertions);

    // 1. Attach to an existing novel-tts rather than racing it on state.json.
    if probe(settings.port) == Probe::NovelTts {
        let base = format!("http://127.0.0.1:{}", settings.port);
        let mut st = BackendState::phase("attached");
        st.base = Some(base.clone());
        st.message = Some("attached to a server started elsewhere".into());
        publish(app, &base)?;
        emit(app, epoch, st);
        return Ok(());
    }

    // 2. Otherwise pick a port we can actually have.
    let mut last_err = String::new();
    for attempt in 0..SPAWN_ATTEMPTS {
        let handle = app.state::<Arc<BackendHandle>>();
        if !current(&handle, epoch) {
            return Ok(()); // superseded before this attempt even began
        }

        let port = if probe(settings.port) == Probe::Free {
            settings.port
        } else {
            pick_free_port().map_err(|e| format!("no free port: {e}"))?
        };

        emit(app, epoch, BackendState::phase("spawning"));
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

        let handle = app.state::<Arc<BackendHandle>>();
        if let Some(mut orphan) = store_if_current(&handle, epoch, child) {
            // Superseded between spawning and storing: this process never
            // entered shared state, so nobody else knows about it - we
            // alone are responsible for killing it before we back off.
            orphan.kill_tree();
            return Ok(());
        }

        match wait_ready(app, epoch, port) {
            Ok(()) => {
                if !current(&handle, epoch) {
                    return Ok(());
                }
                let base = format!("http://127.0.0.1:{port}");
                publish(app, &base)?;
                let mut st = BackendState::phase("ready");
                st.base = Some(base);
                emit(app, epoch, st);
                watch_for_exit(app.clone(), epoch);
                return Ok(());
            }
            Err(e) => {
                last_err = e;
                if !current(&handle, epoch) {
                    // Superseded mid-wait: whoever superseded us now owns
                    // (or will shortly own) the child slot. Not ours to
                    // touch - don't kill, don't clear, don't retry.
                    return Ok(());
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
                let tail = cleanup_if_current(&handle, epoch);
                if attempt + 1 < SPAWN_ATTEMPTS && looks_like_a_bind_race(&tail) {
                    continue;
                }
                break;
            }
        }
    }
    Err(last_err)
}

fn wait_ready(app: &AppHandle, epoch: usize, port: u16) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let handle = app.state::<Arc<BackendHandle>>();
        if !current(&handle, epoch) {
            // Superseded mid-wait. Returning Err here (rather than looping
            // forever or returning Ok) routes back through `run`'s Err arm,
            // which re-checks `current` itself before touching the slot -
            // so this can't turn into a kill of a child we no longer own.
            return Err("superseded by a newer run".to_string());
        }
        // A child that already died will never become ready.
        {
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
        emit(app, epoch, st);
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
fn watch_for_exit(app: AppHandle, epoch: usize) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let handle = app.state::<Arc<BackendHandle>>();
        if !current(&handle, epoch) {
            return; // a restart has taken over; that run has its own watcher
        }
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
            emit(&app, epoch, st);
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

    // -- Finding 3: the epoch guard --
    //
    // These exercise `store_if_current`/`cleanup_if_current` directly against
    // a bare `BackendHandle`, the same pattern as `currently_owned`'s tests
    // above: no live `AppHandle` needed, because the epoch-gating logic was
    // deliberately factored out of `run`/`wait_ready` into plain functions
    // over `&BackendHandle` for exactly this reason.

    #[test]
    fn a_superseded_epoch_does_not_clear_or_kill_the_slot() {
        let handle = BackendHandle::default();
        let my_epoch = handle.epoch.load(Ordering::SeqCst);
        let child = BackendChild::spawn(&echo_spec("sleep 30")).expect("spawn a trivial child");
        *handle.child.lock().unwrap() = Some(child);

        // A restart (or a second start()) bumps the epoch out from under us.
        handle.supersede();

        let tail = cleanup_if_current(&handle, my_epoch);
        assert!(
            tail.is_empty(),
            "a superseded cleanup must not read the child's log tail either"
        );

        let mut slot = handle.child.lock().unwrap();
        let child = slot
            .as_mut()
            .expect("slot must remain populated: a superseded run must not clear it");
        assert!(
            child.try_wait().is_none(),
            "a superseded run must not kill a child it no longer owns"
        );
        child.kill_tree(); // test cleanup only
    }

    #[test]
    fn a_current_epoch_does_clear_and_kill_the_slot() {
        // The control case: cleanup_if_current must still do its job when
        // nothing has superseded it, or the guard above would be trivially
        // satisfied by a function that never does anything.
        let handle = BackendHandle::default();
        let my_epoch = handle.epoch.load(Ordering::SeqCst);
        let mut child = BackendChild::spawn(&echo_spec("sleep 30")).expect("spawn a trivial child");
        let alive_before = child.try_wait().is_none();
        assert!(alive_before);
        *handle.child.lock().unwrap() = Some(child);

        cleanup_if_current(&handle, my_epoch);

        assert!(
            handle.child.lock().unwrap().is_none(),
            "an un-superseded cleanup must clear the slot"
        );
    }

    #[test]
    fn a_superseded_epoch_refuses_to_store_and_hands_the_child_back() {
        let handle = BackendHandle::default();
        let my_epoch = handle.epoch.load(Ordering::SeqCst);
        handle.supersede(); // superseded before we ever tried to store

        let child = BackendChild::spawn(&echo_spec("sleep 30")).expect("spawn a trivial child");
        let mut handed_back =
            store_if_current(&handle, my_epoch, child).expect("must hand the child back, not store it");

        assert!(
            handle.child.lock().unwrap().is_none(),
            "a superseded store must never populate the shared slot"
        );
        // The caller (run()) is responsible for killing what it gets back -
        // confirm the returned child is still the live one, not already dead.
        assert!(handed_back.try_wait().is_none());
        handed_back.kill_tree(); // test cleanup only
    }

    #[test]
    fn a_current_epoch_does_store() {
        let handle = BackendHandle::default();
        let my_epoch = handle.epoch.load(Ordering::SeqCst);
        let child = BackendChild::spawn(&echo_spec("sleep 30")).expect("spawn a trivial child");

        assert!(
            store_if_current(&handle, my_epoch, child).is_none(),
            "an un-superseded store must succeed and keep the child"
        );
        let mut slot = handle.child.lock().unwrap();
        assert!(slot.is_some());
        slot.as_mut().unwrap().kill_tree(); // test cleanup only
    }

    #[test]
    fn supersede_advances_current_and_invalidates_the_old_epoch() {
        let handle = BackendHandle::default();
        let e1 = handle.epoch.load(Ordering::SeqCst);
        assert!(current(&handle, e1));

        let e2 = handle.supersede();
        assert_ne!(e1, e2);
        assert!(!current(&handle, e1), "the old epoch must no longer read as current");
        assert!(current(&handle, e2), "the new epoch must read as current");
    }
}
