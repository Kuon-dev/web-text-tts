use tauri::WebviewWindow;

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
