use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::health::{currently_owned, BackendHandle};

const CLEAN_EXIT_GRACE: Duration = Duration::from_secs(3);

/// Stop the backend we own.
///
/// Layer 1 here (close stdin, wait) and layer 2 (killpg / job terminate).
/// Layer 3 is the Windows job object's KILL_ON_JOB_CLOSE, which fires even if
/// this function never runs. Layer 4 is server.py's own stdin watchdog, the
/// only one that reaches inside a WSL2 VM.
///
/// In attach mode this is a no-op: we did not start that server, so it is not
/// ours to stop.
///
/// A thin wrapper: all decision logic lives in `shutdown_backend`, which
/// takes a bare `&BackendHandle` rather than this `&AppHandle` so it can be
/// unit-tested by spawning a `BackendChild` directly (as supervise.rs's own
/// tests do) instead of standing up a live Tauri app. This mirrors
/// `currently_owned` in health.rs, which the same task (12) already pulled
/// out of `emit` for the identical reason.
pub fn shutdown(app: &AppHandle) {
    let handle = app.state::<Arc<BackendHandle>>();
    shutdown_backend(&handle);
}

/// The decision logic behind `shutdown`.
///
/// Ownership is read straight off the live child slot via `currently_owned`
/// (`handle.child.is_some()`), not off `handle.state`'s `owned` flag: that
/// flag is a *snapshot*, stamped once by the last `emit` call, and there is
/// a real window - up to the ~1.5s of one `wait_ready` poll - between a
/// child actually being stored in the slot and the next `emit` refreshing
/// that snapshot to say so. A quit landing in that window used to see a
/// stale `owned = false` and skip cleanup entirely, leaking a live backend
/// process (Finding 3's emit-vs-store TOCTOU). `handle.child.is_some()` has
/// no such lag: attach mode never populates that slot at all (`BackendChild`
/// can only be constructed by `BackendChild::spawn`), so it is always an
/// exact, un-stale answer to "is there something here that is ours to kill".
///
/// Idempotent, and deliberately does not special-case a child that is
/// already gone: closing the stdin of an exited process, `try_wait`-ing one
/// that is already reaped, and `kill_tree`-ing an already-dead process group
/// are all harmless no-ops, so the second call in the
/// `ExitRequested`-then-`Exit` ladder (or a call against the `exited` phase,
/// where a dead child still occupies the slot) just falls through cleanly.
fn shutdown_backend(handle: &BackendHandle) {
    if !currently_owned(handle) {
        return;
    }

    let mut slot = match handle.child.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(child) = slot.as_mut() else {
        return;
    };

    // L1: EOF on stdin — the child's watchdog exits cleanly.
    child.close_stdin();
    let deadline = Instant::now() + CLEAN_EXIT_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().is_some() {
            *slot = None;
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // L2: escalate through the process group / job object.
    child.kill_tree();
    *slot = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::launch::LaunchSpec;
    use crate::backend::supervise::BackendChild;

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
    fn attach_mode_is_a_complete_no_op() {
        // A fresh handle is exactly what attach mode leaves behind for the
        // entire life of the run: `child` is None (attach never populates
        // it). `shutdown_backend` must not touch it.
        let handle = BackendHandle::default();
        shutdown_backend(&handle);
        assert!(
            handle.child.lock().unwrap().is_none(),
            "attach mode must never populate, let alone clear, the child slot"
        );
    }

    #[test]
    fn a_populated_child_is_killed_even_when_state_was_never_emitted() {
        // The emit-vs-store TOCTOU (Finding 3): `handle.state`'s `owned`
        // flag is only ever refreshed by `emit`, and there is a real window
        // - right after a child is stored, before the next `emit` call -
        // where a live, owned child sits in the slot while `state` still
        // says `owned = false` (or, as here, isn't set at all). A quit
        // landing in that window must still find and kill it: ownership is
        // read straight off the live slot (`currently_owned`), not off a
        // snapshot that can lag behind it.
        let handle = BackendHandle::default();
        let child = BackendChild::spawn(&echo_spec("sleep 30")).expect("spawn a trivial child");
        *handle.child.lock().unwrap() = Some(child);
        assert!(handle.state.lock().unwrap().is_none(), "state was never emitted");

        shutdown_backend(&handle);

        assert!(
            handle.child.lock().unwrap().is_none(),
            "a live child in the slot must be killed and cleared regardless \
             of what (if anything) was last emitted to handle.state"
        );
    }

    #[test]
    fn owned_child_that_honors_stdin_close_exits_via_layer_1() {
        // mirrors supervise.rs's `closing_stdin_ends_a_child_that_watches_it`
        // - this is server.py's --exit-on-stdin-close watchdog, standing in.
        let handle = BackendHandle::default();
        let child =
            BackendChild::spawn(&echo_spec("cat > /dev/null")).expect("spawn a trivial child");
        *handle.child.lock().unwrap() = Some(child);

        let started = Instant::now();
        shutdown_backend(&handle);
        let elapsed = started.elapsed();

        assert!(
            handle.child.lock().unwrap().is_none(),
            "slot must be cleared once the child has exited"
        );
        assert!(
            elapsed < CLEAN_EXIT_GRACE,
            "a child that honors stdin EOF should exit well inside the grace \
             window, not fall through to kill_tree escalation: {elapsed:?}"
        );
    }

    #[test]
    fn owned_child_that_ignores_stdin_close_is_escalated_via_layer_2() {
        // `sleep 30` never reads stdin, so closing our end changes nothing
        // for it - the only way it ends is L2's killpg escalation, which
        // only fires after the full grace window (mirrors supervise.rs's own
        // `kill_tree_stops_a_running_child`, driven through `shutdown_backend`
        // instead of calling `kill_tree` directly).
        let handle = BackendHandle::default();
        let child = BackendChild::spawn(&echo_spec("sleep 30")).expect("spawn a trivial child");
        *handle.child.lock().unwrap() = Some(child);

        let started = Instant::now();
        shutdown_backend(&handle);
        let elapsed = started.elapsed();

        assert!(
            handle.child.lock().unwrap().is_none(),
            "slot must be cleared once kill_tree has reaped the child"
        );
        assert!(
            elapsed >= CLEAN_EXIT_GRACE,
            "a child that ignores stdin EOF must not be reaped before the \
             full grace window has elapsed: {elapsed:?}"
        );
    }

    #[test]
    fn shutdown_backend_is_idempotent() {
        // Exactly the ExitRequested-then-Exit ladder: the second call finds
        // an empty slot (cleared by the first) and must fall through
        // cleanly rather than panicking or blocking for another grace
        // window.
        let handle = BackendHandle::default();
        let child =
            BackendChild::spawn(&echo_spec("cat > /dev/null")).expect("spawn a trivial child");
        *handle.child.lock().unwrap() = Some(child);

        shutdown_backend(&handle);
        assert!(handle.child.lock().unwrap().is_none());

        let started = Instant::now();
        shutdown_backend(&handle); // second call: must not block or panic
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "a second call against an already-cleared slot must return immediately"
        );
    }

    #[test]
    fn exited_phase_dead_child_still_in_the_slot_is_reaped_without_delay() {
        // The brief's documented edge case: `watch_for_exit` (health.rs)
        // detects a child that died on its own and emits the "exited"
        // phase, but does not clear `handle.child` - the dead `Child`
        // stays in the slot, so it still reads as owned. `shutdown_backend`
        // must tolerate that rather than special-case it: close_stdin and
        // kill_tree on an already-dead process are harmless no-ops, and the
        // very first try_wait() in the loop should already see it as gone.
        let handle = BackendHandle::default();
        let mut child = BackendChild::spawn(&echo_spec("true")).expect("spawn a trivial child");
        for _ in 0..50 {
            if child.try_wait().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        *handle.child.lock().unwrap() = Some(child);

        let started = Instant::now();
        shutdown_backend(&handle);
        let elapsed = started.elapsed();

        assert!(handle.child.lock().unwrap().is_none());
        assert!(
            elapsed < CLEAN_EXIT_GRACE,
            "an already-dead child must be recognized on the first try_wait, \
             not made to sit out the full grace window: {elapsed:?}"
        );
    }
}
