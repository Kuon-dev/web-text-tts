mod window;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let main = app
                .get_webview_window("main")
                .expect("main window is declared in tauri.conf.json");
            // Placeholder until Task 12 wires real discovery.
            window::inject_api_base(&main, "http://127.0.0.1:8765")?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
