use std::path::PathBuf;

use crate::settings::{BackendMode, DesktopSettings};

/// Everything needed to spawn the backend, with no process started yet so the
/// argv is unit-testable.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

/// Vite dev server origin, mirrored from desktop/vite.config.ts.
const DEV_ORIGIN: &str = "http://localhost:1420";

pub fn build_launch_spec(
    settings: &DesktopSettings,
    port: u16,
    dev: bool,
) -> Result<LaunchSpec, String> {
    let mut env = vec![("PYTHONUNBUFFERED".to_string(), "1".to_string())];
    if let Some(hf) = &settings.hf_home {
        env.push(("HF_HOME".to_string(), hf.display().to_string()));
    }

    let (program, mut args, cwd) = match settings.mode {
        BackendMode::Native => {
            let python = settings.resolve_python()?;
            if !settings.server_py().exists() {
                return Err(format!(
                    "server.py not found in {}",
                    settings.repo_dir.display()
                ));
            }
            (
                python.display().to_string(),
                vec!["-u".to_string(), "server.py".to_string()],
                Some(settings.repo_dir.clone()),
            )
        }
        BackendMode::Wsl => {
            let distro = settings
                .wsl_distro
                .as_deref()
                .ok_or("WSL mode needs wsl_distro")?;
            let repo = settings
                .wsl_repo_dir
                .as_deref()
                .ok_or("WSL mode needs wsl_repo_dir")?;
            let python = settings
                .wsl_python
                .as_deref()
                .ok_or("WSL mode needs wsl_python")?;
            (
                "wsl.exe".to_string(),
                vec![
                    "-d".to_string(),
                    distro.to_string(),
                    "--cd".to_string(),
                    repo.to_string(),
                    // --exec avoids a shell layer between us and python
                    "--exec".to_string(),
                    python.to_string(),
                    "-u".to_string(),
                    "server.py".to_string(),
                ],
                None,
            )
        }
    };

    // Under WSL the data dir is the Linux-side path; natively it is the repo.
    let data_dir = match settings.mode {
        BackendMode::Native => settings.repo_dir.display().to_string(),
        BackendMode::Wsl => settings.wsl_repo_dir.clone().unwrap_or_default(),
    };

    args.extend([
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--data-dir".to_string(),
        data_dir,
        // The only teardown layer that reaches a process inside the WSL VM.
        "--exit-on-stdin-close".to_string(),
    ]);
    if dev {
        args.push("--cors-origin".to_string());
        args.push(DEV_ORIGIN.to_string());
    }
    args.extend(settings.extra_args.iter().cloned());

    Ok(LaunchSpec { program, args, cwd, env })
}

// The brief's tests build a default then reassign fields for readability at
// the call site; keep that shape verbatim rather than switching to struct
// update syntax (matches the same allow in settings.rs).
#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::settings::{BackendMode, DesktopSettings};

    fn native() -> DesktopSettings {
        let mut s = DesktopSettings::default();
        s.repo_dir = std::env::temp_dir().join("novel-repo");
        std::fs::create_dir_all(&s.repo_dir).unwrap();
        // build_launch_spec requires server.py to exist in repo_dir (it
        // refuses to build a launch spec pointing at a script that isn't
        // there); touch a dummy file rather than weakening that check.
        std::fs::write(s.repo_dir.join("server.py"), "").unwrap();
        // point at an interpreter that exists so resolve_python passes
        s.python = std::env::current_exe().unwrap();
        s
    }

    #[test]
    fn native_argv_carries_the_full_contract() {
        let spec = build_launch_spec(&native(), 9123, false).unwrap();
        assert!(spec.args.contains(&"server.py".to_string()));
        assert!(spec.args.contains(&"-u".to_string()));
        assert!(spec.args.contains(&"--exit-on-stdin-close".to_string()));
        let joined = spec.args.join(" ");
        assert!(joined.contains("--port 9123"));
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--data-dir"));
    }

    #[test]
    fn dev_mode_allows_the_vite_origin() {
        let spec = build_launch_spec(&native(), 9123, true).unwrap();
        assert!(spec.args.join(" ").contains("http://localhost:1420"));
    }

    #[test]
    fn release_mode_adds_no_cors_origin() {
        let spec = build_launch_spec(&native(), 9123, false).unwrap();
        assert!(!spec.args.join(" ").contains("--cors-origin"));
    }

    #[test]
    fn a_missing_interpreter_is_rejected_before_spawning() {
        let mut s = native();
        s.python = std::path::PathBuf::from("/nonexistent/python");
        assert!(build_launch_spec(&s, 9123, false).is_err());
    }

    #[test]
    fn wsl_argv_goes_through_wsl_exe() {
        let mut s = DesktopSettings::default();
        s.mode = BackendMode::Wsl;
        s.wsl_distro = Some("Ubuntu".into());
        s.wsl_repo_dir = Some("/home/kuon/web-text-tts".into());
        s.wsl_python = Some("/home/kuon/web-text-tts/.venv311/bin/python".into());
        let spec = build_launch_spec(&s, 9123, false).unwrap();
        assert_eq!(spec.program, "wsl.exe");
        let joined = spec.args.join(" ");
        assert!(joined.contains("-d Ubuntu"));
        assert!(joined.contains("--exec"));
        assert!(joined.contains("/home/kuon/web-text-tts"));
        // the watchdog is not optional here: a Windows job object has no
        // jurisdiction inside the WSL VM
        assert!(spec.args.contains(&"--exit-on-stdin-close".to_string()));
    }

    #[test]
    fn wsl_without_configuration_is_rejected() {
        let mut s = DesktopSettings::default();
        s.mode = BackendMode::Wsl;
        assert!(build_launch_spec(&s, 9123, false).is_err());
    }

    #[test]
    fn extra_args_are_appended() {
        let mut s = native();
        s.extra_args = vec!["--cors-origin".into(), "x://y".into()];
        let spec = build_launch_spec(&s, 9123, false).unwrap();
        assert!(spec.args.join(" ").contains("x://y"));
    }

    #[test]
    fn hf_home_becomes_an_env_var() {
        let mut s = native();
        s.hf_home = Some("/tmp/hf".into());
        let spec = build_launch_spec(&s, 9123, false).unwrap();
        assert!(spec.env.iter().any(|(k, v)| k == "HF_HOME" && v == "/tmp/hf"));
    }
}
