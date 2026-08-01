use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

/// The JS the Rust side evals to flush the reading position before the
/// window/app goes away. Shared by `install_close_flush` (the
/// `WindowEvent::CloseRequested` path) and `flush_position_on_exit` (the
/// `RunEvent::ExitRequested`/`Exit` path Cmd+Q takes instead - see
/// `flush_position_on_exit`'s doc comment) so both call sites stay in sync.
const FLUSH_POSITION_JS: &str = "window.__flushPosition?.()";

/// Build the JS statement that publishes `base` as `window.__API_BASE__`.
///
/// Pulled out of `inject_api_base` so it can be unit-tested without a live
/// `WebviewWindow` (which needs a running event loop).
fn api_base_js(base: &str) -> String {
    format!(
        "window.__API_BASE__ = {};",
        serde_json::to_string(base).expect("string always serializes")
    )
}

/// Publish the Python server's origin to the webview.
///
/// `apiUrl()` in frontend/src/lib/api.ts reads `window.__API_BASE__` at CALL
/// time, so this may land after the bundle has been evaluated. The value must
/// be a bare origin with no trailing slash: player.ts compares
/// `audio.src.endsWith(audioUrl(cid))`.
pub fn inject_api_base(window: &WebviewWindow, base: &str) -> tauri::Result<()> {
    window.eval(api_base_js(base))
}

/// Give the webview a moment to persist the reading position before the window
/// goes away. WKWebView and WebView2 do not reliably run beforeunload, and
/// savePosition() is a 300ms debounce, so without this a quit mid-chapter can
/// drop the last position write.
///
/// `destroy()` is used (not `close()`) to actually tear the window down: per
/// tauri 2.11's WebviewWindow::destroy doc comment, and confirmed in
/// tauri-runtime-wry (WindowMessage::Destroy routes straight to
/// on_window_close, never through on_close_requested), destroy() "does not
/// emit any events" — it cannot re-fire CloseRequested, so this handler
/// cannot re-enter itself.
///
/// The close must always proceed and the window must always end up
/// destroyed, whether or not the `eval` call above succeeds — an `Err` here
/// (webview gone, IPC failure, ...) used to leave `prevent_close()`
/// unreached, which prevented the close but scheduled no `destroy()` to
/// take its place: an unclosable window. Best-effort the flush, but never
/// gate the teardown on it (Finding 7).
pub fn install_close_flush(window: &WebviewWindow) {
    let win = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let _ = win.eval(FLUSH_POSITION_JS);
            api.prevent_close();
            let w = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                let _ = w.destroy();
            });
        }
    });
}

/// Best-effort flush on the app-exit path, before teardown runs.
///
/// `install_close_flush` alone is not enough: on macOS, Cmd+Q goes straight
/// to `applicationWillTerminate:` → `RunEvent::Exit` and never fires
/// `WindowEvent::CloseRequested` at all, so that handler's eval never runs
/// and up to one sentence of reading position (savePosition()'s 300ms
/// debounce) can be lost on quit (Finding 4).
///
/// Deliberately does not wait for a result or sleep before returning: `eval`
/// posts the script to the webview and returns immediately, so this adds no
/// stall to a teardown path that is already slower than it should be (see
/// the F5 finding this branch does not attempt to fix). Called from both
/// `RunEvent::ExitRequested` and `RunEvent::Exit` since Cmd+Q's exact event
/// sequence differs by platform and this call is idempotent either way.
pub fn flush_position_on_exit(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(FLUSH_POSITION_JS);
    }
}

#[cfg(test)]
mod tests {
    use super::api_base_js;

    #[test]
    fn api_base_js_matches_expected_default() {
        assert_eq!(
            api_base_js("http://127.0.0.1:8765"),
            r#"window.__API_BASE__ = "http://127.0.0.1:8765";"#
        );
    }

    #[test]
    fn api_base_js_escapes_quotes_in_base() {
        // Not a value we'd ever inject in practice, but confirms the JS
        // string is built via serde_json (proper escaping) rather than raw
        // interpolation.
        assert_eq!(
            api_base_js("http://\"evil\""),
            r#"window.__API_BASE__ = "http://\"evil\"";"#
        );
    }
}
