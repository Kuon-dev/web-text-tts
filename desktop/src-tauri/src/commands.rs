use std::sync::Arc;

use tauri::AppHandle;

use crate::backend::health::{self, BackendHandle, BackendState};
use crate::settings::DesktopSettings;

#[tauri::command]
pub fn get_backend_state(handle: tauri::State<'_, Arc<BackendHandle>>) -> Option<BackendState> {
    handle.state.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn restart_backend(app: AppHandle, handle: tauri::State<'_, Arc<BackendHandle>>) {
    // Supersede any in-flight run FIRST, before touching the child slot.
    // This is what closes the double-restart race (Finding 3): a run still
    // mid-spawn or mid-`wait_ready` re-checks the epoch under the same lock
    // this function uses next, so by the time we acquire it, that run has
    // either already stored its (now-current) child - which we then kill
    // below, correctly - or has seen the bump and backed off without
    // storing anything at all. Either way there is nothing left for it to
    // race us over. `health::start` bumps again internally for the run it
    // spawns; bumping twice on a restart is harmless, only monotonic.
    handle.supersede();
    if let Ok(mut slot) = handle.child.lock() {
        if let Some(child) = slot.as_mut() {
            child.close_stdin();
            child.kill_tree();
        }
        *slot = None;
    }
    health::start(app);
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> DesktopSettings {
    DesktopSettings::load(&app)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: DesktopSettings) -> Result<(), String> {
    settings.save(&app).map_err(|e| e.to_string())
}
