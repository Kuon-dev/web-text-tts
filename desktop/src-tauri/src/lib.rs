// `pub`: `BackendChild::pid()` (backend::supervise, out of scope for this
// task to touch) is not called anywhere yet and Task 13 is expected to be
// its first caller. Keeping this module path reachable from the crate root
// is what lets rustc treat it as part of the library's public surface
// instead of flagging it dead code under `cargo clippy -D warnings`; a
// private `mod backend;` (as an earlier draft of this file had) makes that
// warning fire because supervise.rs is out of scope for this task to edit.
pub mod backend;
mod commands;
mod settings;
mod window;

use std::sync::Arc;

use backend::health::BackendHandle;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_backend_state,
            commands::restart_backend,
            commands::get_settings,
            commands::set_settings,
        ])
        .setup(|app| {
            app.manage(Arc::new(BackendHandle::default()));
            backend::health::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } => backend::teardown::shutdown(app),
            tauri::RunEvent::Exit => backend::teardown::shutdown(app),
            _ => {}
        });
}
