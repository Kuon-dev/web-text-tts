use std::time::Duration;

use tauri::{WebviewWindow, WindowEvent};

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
pub fn install_close_flush(window: &WebviewWindow) {
    let win = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if win.eval("window.__flushPosition?.()").is_ok() {
                api.prevent_close();
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(150));
                    let _ = w.destroy();
                });
            }
        }
    });
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
