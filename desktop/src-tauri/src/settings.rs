use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackendMode {
    /// A Python interpreter on this machine.
    Native,
    /// A Python interpreter inside a WSL2 distro, reached through wsl.exe.
    Wsl,
}

// A manual impl (equivalent to #[derive(Default)] with #[default] on Native)
// keeps this file matching the task brief verbatim.
#[allow(clippy::derivable_impls)]
impl Default for BackendMode {
    fn default() -> Self {
        BackendMode::Native
    }
}

/// Inputs to the backend process spawn.
///
/// Deliberately NOT tauri-plugin-store: these values become process arguments,
/// so they must be a typed struct the webview cannot rewrite field by field.
/// `#[serde(default)]` on every field means an older or hand-edited file loads
/// rather than failing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DesktopSettings {
    pub mode: BackendMode,
    /// Host-side path to the web-text-tts checkout (holds server.py).
    pub repo_dir: PathBuf,
    /// Interpreter to run. Must have torch: on this repo that is .venv311,
    /// NOT .venv (which is 3.14 without torch).
    pub python: PathBuf,
    pub wsl_distro: Option<String>,
    /// Linux-side path to the checkout inside the distro. Prefer a native ext4
    /// path: /mnt/c is 5-20x slower for the WAV cache.
    pub wsl_repo_dir: Option<String>,
    pub wsl_python: Option<String>,
    pub port: u16,
    pub extra_args: Vec<String>,
    pub hf_home: Option<PathBuf>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        // The desktop app lives at <repo>/desktop/src-tauri, so the checkout is
        // two levels up from the crate at build time. At runtime the packaged
        // app has no such relationship, hence the setting.
        let repo = default_repo_dir();
        Self {
            mode: BackendMode::Native,
            python: default_python(&repo),
            repo_dir: repo,
            wsl_distro: None,
            wsl_repo_dir: None,
            wsl_python: None,
            port: 8765,
            extra_args: Vec::new(),
            hf_home: None,
        }
    }
}

fn default_repo_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

/// Prefer .venv311 (3.11, torch) over .venv (3.14, no torch).
fn default_python(repo: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "python.exe" } else { "python" };
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    for venv in [".venv311", ".venv"] {
        let p = repo.join(venv).join(bin).join(exe);
        if p.exists() {
            return p;
        }
    }
    repo.join(".venv311").join(bin).join(exe)
}

impl DesktopSettings {
    fn path(app: &AppHandle) -> PathBuf {
        app.path()
            .app_config_dir()
            .expect("app config dir is always resolvable")
            .join("settings.json")
    }

    pub fn load(app: &AppHandle) -> Self {
        std::fs::read_to_string(Self::path(app))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app: &AppHandle) -> std::io::Result<()> {
        let path = Self::path(app);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // temp + rename so a crash mid-write cannot truncate the file
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }

    /// Validate the interpreter before spawning, so a bad path fails as
    /// "choose an interpreter" rather than an ImportError traceback.
    pub fn resolve_python(&self) -> Result<PathBuf, String> {
        if self.mode == BackendMode::Wsl {
            return Err("WSL mode resolves its interpreter inside the distro".into());
        }
        if !self.python.exists() {
            return Err(format!("interpreter not found: {}", self.python.display()));
        }
        Ok(self.python.clone())
    }

    pub fn server_py(&self) -> PathBuf {
        self.repo_dir.join("server.py")
    }
}

// The brief's tests build a default then reassign fields for readability at
// the call site; keep that shape verbatim rather than switching to struct
// update syntax.
#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_repo_layout() {
        let s = DesktopSettings::default();
        assert_eq!(s.port, 8765);
        assert!(matches!(s.mode, BackendMode::Native));
        assert!(s.wsl_distro.is_none());
    }

    #[test]
    fn roundtrips_through_json() {
        let mut s = DesktopSettings::default();
        s.port = 9123;
        s.repo_dir = PathBuf::from("/tmp/repo");
        let text = serde_json::to_string(&s).unwrap();
        let back: DesktopSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.port, 9123);
        assert_eq!(back.repo_dir, PathBuf::from("/tmp/repo"));
    }

    #[test]
    fn unknown_fields_do_not_break_loading() {
        let text = r#"{"port": 7000, "some_future_field": true}"#;
        let s: DesktopSettings = serde_json::from_str(text).unwrap();
        assert_eq!(s.port, 7000);
        // everything else falls back to defaults
        assert!(matches!(s.mode, BackendMode::Native));
    }

    #[test]
    fn resolve_python_rejects_a_missing_interpreter() {
        let mut s = DesktopSettings::default();
        s.python = PathBuf::from("/nonexistent/bin/python");
        assert!(s.resolve_python().is_err());
    }
}
