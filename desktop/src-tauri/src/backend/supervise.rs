use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::launch::LaunchSpec;

/// Enough scrollback for a reloaded webview to backfill a failed startup.
pub const LOG_RING_CAPACITY: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub stream: String,
    pub text: String,
}

pub struct BackendChild {
    child: Child,
    logs: Arc<Mutex<VecDeque<LogLine>>>,
    #[cfg(windows)]
    _job: Option<win32job::Job>,
}

impl BackendChild {
    pub fn spawn(spec: &LaunchSpec) -> std::io::Result<Self> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        // Own the whole process tree so teardown can reach grandchildren.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()?;

        // A job object with KILL_ON_JOB_CLOSE is the only layer that survives
        // a Rust panic or Task Manager killing us.
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            win32job::Job::create()
                .and_then(|j| {
                    let mut info = j.query_extended_limit_info()?;
                    info.limit_kill_on_job_close();
                    j.set_extended_limit_info(&mut info)?;
                    j.assign_process(child.as_raw_handle() as _)?;
                    Ok(j)
                })
                .ok()
        };

        let logs = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_RING_CAPACITY)));
        if let Some(out) = child.stdout.take() {
            Self::pump(out, "stdout", Arc::clone(&logs));
        }
        if let Some(err) = child.stderr.take() {
            Self::pump(err, "stderr", Arc::clone(&logs));
        }

        Ok(Self {
            child,
            logs,
            #[cfg(windows)]
            _job: job,
        })
    }

    fn pump<R: std::io::Read + Send + 'static>(
        reader: R,
        stream: &'static str,
        logs: Arc<Mutex<VecDeque<LogLine>>>,
    ) {
        std::thread::spawn(move || {
            // Read raw bytes rather than `BufRead::lines()`: `lines()` yields
            // an `Err` for a line that isn't valid UTF-8, and iterator
            // adapters like `map_while`/`take_while` stop on the first `Err`
            // - one stray byte (e.g. in a Python traceback) would silently
            // end log capture for the rest of the child's life, and stop
            // draining the OS pipe, which can eventually block the child's
            // writes. Decoding lossily keeps the reader going no matter what
            // bytes show up, at the cost of `\u{FFFD}` in place of bad bytes.
            let mut reader = BufReader::new(reader);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => return, // EOF
                    Ok(_) => {}
                    Err(_) => return, // real I/O error on the pipe
                }
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                    if buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                }
                let text = String::from_utf8_lossy(&buf).into_owned();

                let mut guard = match logs.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if guard.len() == LOG_RING_CAPACITY {
                    guard.pop_front();
                }
                guard.push_back(LogLine { stream: stream.to_string(), text });
            }
        });
    }

    pub fn logs(&self) -> Vec<LogLine> {
        self.logs.lock().map(|g| g.iter().cloned().collect()).unwrap_or_default()
    }

    /// Last N lines, for the startup screen's failure display.
    pub fn log_tail(&self, n: usize) -> Vec<LogLine> {
        let all = self.logs();
        all[all.len().saturating_sub(n)..].to_vec()
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Drop the write end of the child's stdin. server.py's --exit-on-stdin-close
    /// watchdog sees EOF and exits. This is teardown layer 1.
    pub fn close_stdin(&mut self) {
        self.child.stdin.take();
    }

    pub fn try_wait(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Teardown layer 2: signal the whole process group, escalating after a
    /// grace period.
    pub fn kill_tree(&mut self) {
        #[cfg(unix)]
        {
            let pgid = self.child.id() as i32;
            unsafe { libc::killpg(pgid, libc::SIGTERM) };
            for _ in 0..20 {
                if self.try_wait().is_some() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

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
    fn captures_stdout_and_stderr() {
        let child = BackendChild::spawn(&echo_spec("echo hello; echo oops 1>&2")).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let logs = child.logs();
        assert!(logs.iter().any(|l| l.text.contains("hello") && l.stream == "stdout"));
        assert!(logs.iter().any(|l| l.text.contains("oops") && l.stream == "stderr"));
    }

    #[test]
    fn ring_buffer_is_bounded() {
        let child = BackendChild::spawn(&echo_spec(
            "i=0; while [ $i -lt 2500 ]; do echo line$i; i=$((i+1)); done",
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(child.logs().len() <= LOG_RING_CAPACITY);
    }

    #[test]
    fn closing_stdin_ends_a_child_that_watches_it() {
        // mimics server.py's _watch_stdin: read until EOF, then exit
        let mut child = BackendChild::spawn(&echo_spec("cat > /dev/null")).unwrap();
        child.close_stdin();
        for _ in 0..50 {
            if child.try_wait().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("child did not exit after stdin closed");
    }

    #[test]
    fn kill_tree_stops_a_running_child() {
        let mut child = BackendChild::spawn(&echo_spec("sleep 30")).unwrap();
        child.kill_tree();
        for _ in 0..50 {
            if child.try_wait().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("child survived kill_tree");
    }

    #[test]
    fn kill_tree_escalates_to_sigkill_when_sigterm_is_ignored() {
        // `sleep 30` above dies on the initial SIGTERM and never exercises
        // the SIGKILL escalation path. A child that ignores TERM does - but
        // only if kill_tree() isn't called until the shell has actually
        // exec'd and installed the trap. spawn() returns as soon as fork()
        // completes, well before exec(); an earlier version of this test
        // called kill_tree() immediately, so the initial SIGTERM sometimes
        // arrived while the shell was still at its *default* disposition and
        // died there instead - a false pass (try_wait().is_some() can't tell
        // "died from SIGTERM" from "died from SIGKILL"), caught by review via
        // a 0.11s runtime against a 2s grace window. So: block until the
        // child proves the trap is installed before sending anything.
        let mut child =
            BackendChild::spawn(&echo_spec("trap '' TERM; echo ready; sleep 30 & wait")).unwrap();

        let ready_by = Instant::now() + Duration::from_secs(5);
        loop {
            if child.logs().iter().any(|l| l.text == "ready") {
                break;
            }
            assert!(
                Instant::now() < ready_by,
                "child never announced readiness; trap may not have installed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        // kill_tree's grace-period loop (and thus everything below that
        // depends on its timing or on a SIGKILL having been sent) only
        // exists on the #[cfg(unix)] branch of kill_tree - the non-unix
        // branch is an immediate `Child::kill()` with no grace window at
        // all. Keep the two expectations platform-separated rather than
        // asserting a unix-only timing bound unconditionally.
        #[cfg(unix)]
        {
            let started = Instant::now();
            child.kill_tree();
            let elapsed = started.elapsed();

            // The discriminator itself: a SIGTERM death returns in ~100ms
            // (one poll of the grace loop); only a genuine escalation to
            // SIGKILL takes the full ~2s grace window (20 x 100ms). Do not
            // shorten the production grace period to make this cheaper.
            assert!(
                elapsed >= Duration::from_millis(1800),
                "kill_tree returned in {elapsed:?} - too fast to have \
                 escalated to SIGKILL (grace window is ~2s); the child \
                 likely died on the initial SIGTERM instead"
            );

            use std::os::unix::process::ExitStatusExt;
            let status = child
                .try_wait()
                .expect("kill_tree's final wait() should have reaped the child by now");
            assert_eq!(
                status.signal(),
                Some(libc::SIGKILL),
                "child did not die from SIGKILL: {status:?}"
            );
        }
        #[cfg(not(unix))]
        {
            // No grace window here to assert on - `kill_tree`'s non-unix arm
            // just calls `Child::kill()` and waits, so an immediate death is
            // the honest (and only) expectation. Note this test's shell
            // script (trap/echo/&/wait) isn't valid `cmd.exe` syntax either,
            // so this arm exists to keep the file cfg-coherent, not to claim
            // this test is functionally meaningful on Windows - see the
            // module-level Windows caveat.
            child.kill_tree();
            assert!(child.try_wait().is_some(), "child survived kill_tree");
        }
    }

    #[test]
    fn a_bad_byte_does_not_truncate_the_stream() {
        // A stray non-UTF-8 byte (e.g. inside a Python traceback) must not
        // silently end log capture for the rest of the child's life -
        // that's exactly when log_tail's failure display matters most.
        let child = BackendChild::spawn(&echo_spec(
            "printf 'good1\\n'; printf '\\377\\377\\377\\n'; printf 'good2\\n'",
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let logs = child.logs();
        assert!(logs.iter().any(|l| l.text.contains("good1")));
        assert!(
            logs.iter().any(|l| l.text.contains("good2")),
            "line after the bad byte was dropped: {logs:?}"
        );
    }
}
