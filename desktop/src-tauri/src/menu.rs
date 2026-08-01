// Accelerators here are deliberately all MODIFIED (CmdOrCtrl+... or similar).
// `App.tsx:37-59` already handles bare Space and the bare arrow keys at the
// document level with a focus-suppression selector; a native menu
// accelerator fires globally regardless of focus, so a bare-key binding here
// would break typing a space in the paste textarea and arrow-key navigation
// in the voice combobox.
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

pub fn build(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    #[cfg(target_os = "macos")]
    let pkg = app.package_info().name.clone();

    // macOS requires an Edit submenu with the predefined items, or Cmd+C /
    // Cmd+V do not work in the paste textarea at all.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("paste", "Paste Chapter…")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("restart-backend", "Restart Backend")
                .accelerator("CmdOrCtrl+Shift+R")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("reveal-data", "Reveal Data Folder").build(app)?)
        .separator()
        .close_window()
        .build()?;

    let playback = SubmenuBuilder::new(app, "Playback")
        .item(
            &MenuItemBuilder::with_id("play-pause", "Play / Pause")
                .accelerator("CmdOrCtrl+Space")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("prev", "Previous Sentence")
                .accelerator("CmdOrCtrl+Left")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("next", "Next Sentence")
                .accelerator("CmdOrCtrl+Right")
                .build(app)?,
        )
        .build()?;

    let view = SubmenuBuilder::new(app, "View").fullscreen().minimize().build()?;

    #[cfg(target_os = "macos")]
    {
        // The app menu must come first; its title is replaced by the app name.
        let app_menu = SubmenuBuilder::new(app, pkg)
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &playback, &view])
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file, &edit, &playback, &view])
    }
}

pub fn handle(app: &AppHandle<Wry>, id: &str) {
    match id {
        "reveal-data" => {
            let settings = crate::settings::DesktopSettings::load(app);
            let _ = tauri_plugin_opener::open_path(settings.repo_dir, None::<&str>);
        }
        other => {
            let _ = app.emit(&format!("menu://{other}"), ());
        }
    }
}
