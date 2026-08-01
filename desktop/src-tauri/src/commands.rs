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
