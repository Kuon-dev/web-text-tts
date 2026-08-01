# Tauri 2 Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `novel-tts` as a desktop app that reproduces every feature of the web app, by wrapping the existing Python backend in a Tauri 2 shell that supervises it as a child process and rendering the existing React UI from a shared source tree.

**Architecture:** `desktop/` is a new npm workspace whose Vite build aliases `@` into `../frontend/src`, so both apps compile the same React tree. Rust owns one `python server.py` child: discover-or-attach on a port, spawn, poll readiness, stream logs, and kill it through a four-layer teardown ladder. The webview loads from `tauri://localhost` and reaches the backend through a single injected base URL. Spec: `docs/superpowers/specs/2026-08-01-desktop-tauri-design.md`.

**Tech Stack:** Rust 1.88 + Tauri 2.11, React 19 + Vite 8 + Tailwind 4 (shared from `frontend/`), Python 3.11 (`.venv311`) FastAPI backend, pytest + vitest.

## Global Constraints

- All paths relative to the repo root (the directory containing `server.py`). Work on branch `feat/desktop-tauri`, which is based on `a370a19` (= `master`).
- **Git commits: author `Kuon <aaronlyn88@gmail.com>`. NEVER add a `Co-Authored-By` trailer.** This is the repo convention (63 of 70 commits follow it; only the 7 MCP commits of 2026-08-01 deviate — do not copy them).
- **Python test runner is `.venv/bin/pytest`** (Python 3.14, no torch — fast suite only). **Python runtime for the sidecar is `.venv311/bin/python`** (Python 3.11, torch + kokoro present). These are different interpreters on purpose. `.venv311` has no pytest.
- **Never run `bash start.sh`.** It is broken in this checkout: `.venv/.deps-installed` does not exist, so it would run `python3 -m venv .venv` and then `pip install -r requirements.txt`, attempting a multi-GB torch install into the Python 3.14 venv. To start a server by hand, always use `.venv311/bin/python server.py`. Fixing `start.sh` is **out of scope** for this branch — do not touch it — but every backend change must still leave its no-flags code path behaviorally identical, which is what Task 5 Step 6 verifies.
- **Baseline test state before any work: `183 passed, 1 failed, 2 deselected`.** The failure is pre-existing and unrelated: `tests/test_romaji.py::test_phonemes_stay_within_kokoro_vocab` raises `ModuleNotFoundError: No module named 'misaki'`. Do not try to fix it; do not count it as a regression. Any *other* failure is yours.
- The fast suite (`.venv/bin/pytest -m "not slow"`) must reach that same baseline after every task, on a machine with no GPU and no `qwen-tts`. Never import `torch`, `kokoro`, or `qwen_tts` at module top level.
- **Every backend change is additive and must default to today's behavior.** `bash start.sh`, `python server.py`, and the web app at `http://localhost:8765` must be byte-for-byte unaffected in behavior. This is verified explicitly in Tasks 4 and 5.
- Node is `v24.3.0`, npm `11.4.2`, at `/opt/homebrew/bin`. Rust is 1.88.0 (Homebrew). Xcode Command Line Tools are installed. The Tauri CLI is **not** installed globally and must come in as a workspace devDependency.
- Pinned dependency versions (verified against crates.io and npm on 2026-08-01):
  `tauri` 2.11.5 · `tauri-build` 2.6.3 · `tauri-plugin-single-instance` 2.4.3 · `tauri-plugin-window-state` 2.4.1 · `tauri-plugin-opener` 2.5.4 · `win32job` 2 · `@tauri-apps/cli` 2.11.4 · `@tauri-apps/api` 2.11.1 · `vitest` 4.1.10. Pin the major in `Cargo.toml` (`"2"`).
- **No HTTP-client crate.** The readiness probe is hand-rolled over `std::net::TcpStream` with a `Connection: close` request header so read-to-EOF terminates cleanly. Do not add `ureq`/`reqwest`.
- macOS deployment target is `13.3`; Vite build target is `safari16` on macOS and `chrome105` on Windows. Never `safari13` — `index.css` uses `oklch()`/`color-mix()` and `watermark.ts:61` uses a regex lookbehind with no fallback.
- The desktop Vite build outputs to `desktop/dist`. **Never** `../static` — `frontend/vite.config.ts:19-22` builds there with `emptyOutDir: true` and would delete the web app's bundle.
- Line numbers below were checked against `a370a19`. Re-read a file before editing it.

---

### Task 1: Single API base-URL injection point

Makes every server URL in the shared frontend route through one function, so the desktop can point it at `http://127.0.0.1:<port>` while the web app keeps using same-origin paths. Also introduces vitest, since the repo has no JS test runner today.

**Files:**
- Modify: `frontend/src/lib/api.ts:62-104`
- Modify: `frontend/src/lib/wallpaper.ts:11,18,33,44`
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.ts`
- Test: `frontend/src/lib/api.test.ts`

**Interfaces:**
- Produces: `apiUrl(path: string): string` exported from `@/lib/api`, and the global `window.__API_BASE__?: string`. Every later task and the Rust injection in Task 7 depend on these exact names.

- [ ] **Step 1: Add vitest**

```bash
cd frontend && npm install -D vitest@4.1.10
```

Add to `frontend/package.json` `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 2: Create `frontend/vitest.config.ts`**

```ts
import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
})
```

- [ ] **Step 3: Write the failing test**

Create `frontend/src/lib/api.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest"
import { apiUrl, audioUrl, imageUrl } from "./api"

afterEach(() => {
  delete (globalThis as { __API_BASE__?: string }).__API_BASE__
})

describe("apiUrl", () => {
  it("returns the path unchanged when no base is set (web app)", () => {
    expect(apiUrl("/api/doc")).toBe("/api/doc")
    expect(audioUrl("abc")).toBe("/api/audio/abc")
    expect(imageUrl("def")).toBe("/api/image/def")
  })

  it("prefixes the base when one is set (desktop)", () => {
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = "http://127.0.0.1:8765"
    expect(apiUrl("/api/doc")).toBe("http://127.0.0.1:8765/api/doc")
    expect(audioUrl("abc")).toBe("http://127.0.0.1:8765/api/audio/abc")
  })

  it("is read at call time, not module-eval time", () => {
    expect(apiUrl("/api/doc")).toBe("/api/doc")
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = "http://127.0.0.1:9999"
    expect(apiUrl("/api/doc")).toBe("http://127.0.0.1:9999/api/doc")
  })

  // player.ts:246 and :380 compare `audio.src.endsWith(audioUrl(cid))`.
  // With base "" the element absolutizes to <origin>/api/audio/x, which ends
  // with the relative form. With an absolute base both sides are identical.
  // Either way the base must carry no trailing slash and no query string.
  it("keeps the endsWith invariant usable under both bases", () => {
    expect("http://localhost:8765/api/audio/x".endsWith(audioUrl("x"))).toBe(true)
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = "http://127.0.0.1:8765"
    expect("http://127.0.0.1:8765/api/audio/x".endsWith(audioUrl("x"))).toBe(true)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL — `apiUrl` is not exported from `./api`.

- [ ] **Step 5: Add `apiUrl` to `frontend/src/lib/api.ts`**

Insert directly above `export async function api<T>(...)` (currently line 62):

```ts
declare global {
  interface Window {
    __API_BASE__?: string
  }
}

/**
 * Origin of the Python server. "" = same-origin: the web app and the vite dev
 * proxy. The desktop shell sets window.__API_BASE__ before the app mounts.
 *
 * Read at CALL time, never at module-eval time, so the Rust-side injection can
 * land after this module has been evaluated.
 *
 * Read via globalThis rather than window: in every real browser/webview
 * window IS globalThis, so this is equivalent there, but it also works in the
 * plain-node environment the unit tests run under, where `window` does not
 * exist at all.
 *
 * INVARIANT: no trailing slash and no query string. player.ts compares
 * `audio.src.endsWith(audioUrl(cid))`, which only holds while the base is a
 * bare origin.
 */
const base = () =>
  (globalThis as { __API_BASE__?: string }).__API_BASE__ ??
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  ""

export const apiUrl = (path: string) => base() + path
```

- [ ] **Step 6: Route the four call sites in `api.ts` through it**

Line 70 — note the error message on line 73 keeps using the bare `path`, so error text is unchanged:

```ts
  const resp = await fetch(apiUrl(path), init)
```

Lines 86, 88, 98:

```ts
export const audioUrl = (cid: string) => apiUrl(`/api/audio/${cid}`)

export const imageUrl = (iid: string) => apiUrl(`/api/image/${iid}`)
```

```ts
  const resp = await fetch(apiUrl("/api/image"), { method: "POST", body: blob })
```

The single edit at line 70 also covers `getEngines`, `getVoices`, `uploadClone`, `deleteClone`, `importImageUrl`, and all ten `api()` calls in `player.ts`.

- [ ] **Step 7: Route `frontend/src/lib/wallpaper.ts` through it**

Add the import at the top:

```ts
import { apiUrl } from "./api"
```

Then lines 11, 18, 33, 44:

```ts
export const wallpaperUrl = (info: WallpaperInfo) => apiUrl(`/api/wallpaper?v=${info.id}`)
```

```ts
    fetch(apiUrl("/api/wallpaper/info"))
```

```ts
      const resp = await fetch(apiUrl("/api/wallpaper"), { method: "POST", body: file })
```

```ts
      const resp = await fetch(apiUrl("/api/wallpaper"), { method: "DELETE" })
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS, 4 tests.

- [ ] **Step 9: Verify the web app is unaffected**

Run: `cd frontend && npm run build`
Expected: `tsc -b` clean, build succeeds, `../static/` regenerated.

Then confirm no absolute URL leaked into the bundle:

```bash
cd frontend && grep -rn "127\.0\.0\.1" ../static/assets/*.js | head
```

Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/wallpaper.ts \
        frontend/src/lib/api.test.ts frontend/vitest.config.ts \
        frontend/package.json frontend/package-lock.json static/
git commit -m "feat: single injection point for the API base URL

Every server URL in the shared frontend now routes through apiUrl(), read at
call time so a host shell can set window.__API_BASE__ after module eval. The
web build is unchanged: with no base set apiUrl() returns today's exact
strings. Adds vitest, which the frontend did not have."
```

---

### Task 2: Flush the reading position on close

`savePosition()` is a 300 ms debounce with no flush path, and webviews do not reliably run `beforeunload`. Quitting mid-chapter can lose your place. This benefits the web app too.

**Files:**
- Modify: `frontend/src/lib/player.ts:388-393`
- Test: `frontend/src/lib/player.test.ts`

**Interfaces:**
- Consumes: `apiUrl` from Task 1.
- Produces: `player.flushPosition(): void` — a public method on the exported `player` singleton. Task 16 calls it through `window.__flushPosition`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/player.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest"

// player.ts constructs `new Audio()` at module scope, which does not exist in
// the node environment — stub it before importing the module under test.
class FakeAudio {
  src = ""
  volume = 1
  muted = false
  playbackRate = 1
  currentTime = 0
  ended = false
  addEventListener() {}
  pause() {}
  play() {
    return Promise.resolve()
  }
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("flushPosition POSTs immediately instead of waiting out the debounce", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal("fetch", fetchMock)

  const { player } = await import("./player")
  player.flushPosition()

  const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/state"))
  expect(posts.length).toBe(1)
  expect(JSON.parse(posts[0][1].body)).toHaveProperty("position")
  expect(posts[0][1].keepalive).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test -- player`
Expected: FAIL — `player.flushPosition is not a function`.

- [ ] **Step 3: Implement `flushPosition`**

In `frontend/src/lib/player.ts`, replace the `savePosition` method (currently lines 388-393) with:

```ts
  private savePosition() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flushPosition(), SAVE_DEBOUNCE_MS)
  }

  /** Persist the position right now, cancelling any pending debounce.
   *  `keepalive` lets the request outlive a webview teardown — WKWebView and
   *  WebView2 do not reliably run beforeunload, so without this a quit
   *  mid-chapter loses up to SAVE_DEBOUNCE_MS of progress. */
  flushPosition() {
    // Same gate jump() uses. Without it, a close before loadDoc() resolves
    // would POST the initial idx of 0 and overwrite the real saved position
    // with zero — the very loss this method exists to prevent.
    if (!this.doc.chunks.length) return
    clearTimeout(this.saveTimer)
    fetch(apiUrl("/api/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: this.idx }),
      keepalive: true,
    }).catch(() => {})
  }
```

Add `apiUrl` to the existing import from `./api` at the top of the file:

```ts
import {
  api,
  apiUrl,
  audioUrl,
  getVoices,
  ...
} from "./api"
```

`flushPosition` uses `fetch` directly rather than `api()` because `api()` has no
way to pass `keepalive`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the build still type-checks**

Run: `cd frontend && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/player.ts frontend/src/lib/player.test.ts static/
git commit -m "feat: flush the reading position immediately on demand

savePosition() was a 300ms debounce with no flush path, so a webview teardown
(which does not reliably run beforeunload) could drop the last position write.
flushPosition() cancels the debounce and POSTs with keepalive."
```

---

### Task 3: Extract the pre-paint theme bootstrap

`frontend/index.html:9-25` is a hand-written IIFE holding its own copies of the accent and scheme lists — already a three-way duplication with `theme.ts:4-15` and `index.css`. The desktop needs its own HTML, which would make it four. Extract once.

**Files:**
- Create: `frontend/public/theme-boot.js`
- Modify: `frontend/index.html:9-25`

**Interfaces:**
- Produces: `frontend/public/` as the shared Vite `publicDir`, and `/theme-boot.js` as a classic script both HTML entry points load. Task 6 points the desktop's `publicDir` here.

- [ ] **Step 1: Create `frontend/public/theme-boot.js`**

The `public/` directory does not exist yet. Copy the IIFE body verbatim out of `index.html` — do not retype it, the accent and scheme lists must stay identical to `theme.ts`:

```js
// Apply the saved theme before first paint (kept in sync with src/lib/theme.ts).
// Loaded as a CLASSIC script by both index.html files — a module script is
// deferred and would flash the wrong theme.
;(function () {
  var t = {}
  try { t = JSON.parse(localStorage.getItem("novel-tts:theme")) || {} } catch (e) {}
  var mode = t.mode === "light" || t.mode === "system" ? t.mode : "dark"
  var dark = mode === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : mode === "dark"
  var root = document.documentElement
  root.classList.toggle("dark", dark)
  var accents = ["indigo", "emerald", "rose", "amber", "sky"]
  root.dataset.accent = accents.indexOf(t.accent) >= 0 ? t.accent : "indigo"
  var schemes = ["zinc", "catppuccin", "dracula", "everforest", "gruvbox", "nord", "rosepine", "solarized", "tokyonight"]
  root.dataset.scheme = schemes.indexOf(t.scheme) >= 0 ? t.scheme : "zinc"
})()
```

- [ ] **Step 2: Replace the inline block in `frontend/index.html`**

Delete lines 9-25 (the whole `<script>…</script>`) and put in its place:

```html
    <script src="/theme-boot.js"></script>
```

- [ ] **Step 3: Rebuild and verify the theme still applies before paint**

Run: `cd frontend && npm run build`

Then confirm the emitted HTML references the file and that it was copied:

```bash
grep -n "theme-boot" ../static/index.html && ls ../static/theme-boot.js
```

Expected: the script tag is present and `static/theme-boot.js` exists.

- [ ] **Step 4: Verify no flash in the browser**

Run: `.venv311/bin/python server.py`, open `http://localhost:8765`, set a light theme in settings, hard-reload.
Expected: the page paints light immediately, with no dark flash.

- [ ] **Step 5: Commit**

```bash
git add frontend/public/theme-boot.js frontend/index.html static/
git commit -m "refactor: extract the pre-paint theme bootstrap to public/theme-boot.js

The IIFE carried its own copies of the accent and scheme lists. The desktop
app needs a second index.html, which would have made that a fourth copy.
Loaded as a classic script so it still runs before first paint."
```

---

### Task 4: CORS for the desktop origin

Without this the desktop cannot talk to the server at all. Worse than plain failure: `POST /api/voices/clone` sends a bare `ArrayBuffer` and therefore sets no `Content-Type`, making it a *simple* request that reaches the handler and writes the clone to disk while the JS promise rejects.

**Files:**
- Modify: `server.py:160-161` (signature), `server.py:222` (app construction)
- Test: `tests/test_cors.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `create_app(..., cors_origins: list[str] | None = None)`. Task 5 passes `args.cors_origin` into it.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cors.py`. It reuses `FakeWorker` and `FakeManager` from the existing `tests/test_server.py` — read that file first and import them rather than duplicating:

```python
"""CORS for the Tauri desktop origin (spec 2026-08-01-desktop-tauri-design)."""
from fastapi.testclient import TestClient

from server import create_app
from tests.test_server import FakeManager, FakeWorker

TAURI = "tauri://localhost"


def _client(tmp_path, **kw):
    worker = FakeWorker(tmp_path / "cache")
    return TestClient(create_app(tmp_path, worker, manager=FakeManager(), **kw))


def test_desktop_origin_gets_allow_origin(tmp_path):
    r = _client(tmp_path).get("/api/engines", headers={"Origin": TAURI})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == TAURI


def test_preflight_allows_delete(tmp_path):
    """deleteClone and removeWallpaper use DELETE; FastAPI has no OPTIONS route
    for those paths, so without CORSMiddleware installing the preflight
    responder they would 405."""
    r = _client(tmp_path).options(
        "/api/wallpaper",
        headers={"Origin": TAURI,
                 "Access-Control-Request-Method": "DELETE"},
    )
    assert r.status_code == 200
    assert "DELETE" in r.headers["access-control-allow-methods"]


def test_preflight_allows_json_content_type(tmp_path):
    """Every api(path, body) call sets Content-Type: application/json."""
    r = _client(tmp_path).options(
        "/api/state",
        headers={"Origin": TAURI,
                 "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "content-type"},
    )
    assert r.status_code == 200


def test_localhost_dev_server_origin_allowed(tmp_path):
    """`tauri dev` serves the UI from http://localhost:1420."""
    r = _client(tmp_path).get(
        "/api/engines", headers={"Origin": "http://localhost:1420"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:1420"


def test_extra_origin_can_be_injected(tmp_path):
    r = _client(tmp_path, cors_origins=["https://example.test"]).get(
        "/api/engines", headers={"Origin": "https://example.test"})
    assert r.headers["access-control-allow-origin"] == "https://example.test"


def test_no_credentials_header(tmp_path):
    """Nothing in the client sends cookies; allow_credentials must stay off."""
    r = _client(tmp_path).get("/api/engines", headers={"Origin": TAURI})
    assert "access-control-allow-credentials" not in r.headers


def test_same_origin_web_app_unaffected(tmp_path):
    """No Origin header (the web app's own requests) still works normally."""
    r = _client(tmp_path).get("/api/engines")
    assert r.status_code == 200
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/test_cors.py -v`
Expected: FAIL — `KeyError: 'access-control-allow-origin'`, and the OPTIONS calls return 405.

- [ ] **Step 3: Add the middleware**

In `server.py`, add the import next to the other FastAPI imports (line 12-15 block):

```python
from fastapi.middleware.cors import CORSMiddleware
```

Add a module-level constant next to `DEFAULT_STATE` (around line 25):

```python
# Origins the Tauri desktop shell can present. Starlette matches allow_origins
# by EXACT STRING, so the custom scheme has to be listed literally — a
# wildcard pattern will not match `tauri://localhost`.
DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost",
                   "https://tauri.localhost"]
```

Change the signature at lines 160-161 to:

```python
def create_app(data_dir: Path, worker, audio_wait: float = 30.0, *, manager,
               engines=None, voice_ids=None, cors_origins=None) -> FastAPI:
```

Insert immediately after `app = FastAPI(lifespan=lifespan)` (line 222):

```python
    # The desktop shell loads its UI from tauri://localhost and calls this
    # server cross-origin. allow_methods=["*"] is what installs the OPTIONS
    # preflight responder — FastAPI has no OPTIONS route for /api/wallpaper or
    # /api/voices/{vid} and would answer 405. allow_credentials stays off:
    # nothing here uses cookies.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[*DESKTOP_ORIGINS, *(cors_origins or [])],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["*"], allow_headers=["*"], max_age=600,
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_cors.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify no regression**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: `194 passed, 1 failed, 2 deselected` — the same single pre-existing `test_romaji` failure and nothing else.

- [ ] **Step 6: Verify the web app still works unchanged**

Run: `.venv311/bin/python server.py`, open `http://localhost:8765`, play a chunk, change a voice.
Expected: identical behavior to before.

- [ ] **Step 7: Commit**

```bash
git add server.py tests/test_cors.py
git commit -m "feat: CORS for the Tauri desktop origin

The desktop shell serves its UI from tauri://localhost and calls this server
cross-origin. Without the preflight responder the two DELETE routes 405, and
POST /api/voices/clone is a simple request that would write the clone to disk
while the UI reported failure."
```

---

### Task 5: Sidecar contract on `main()` — host, port, data dir, stdin watchdog

Lets the Rust supervisor place the server on a chosen port and point it at a data directory, and gives it a teardown channel that reaches into WSL2. All flags default to today's values.

**Files:**
- Modify: `server.py:435-456` (`main()`), plus a new module-level helper
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `create_app(..., cors_origins=...)` from Task 4.
- Produces: the CLI contract `--host` / `--port` / `--data-dir` / `--cors-origin` / `--exit-on-stdin-close`, and `build_parser() -> argparse.ArgumentParser`. Task 10 constructs exactly this argv.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cli.py`:

```python
"""The sidecar CLI contract (spec 2026-08-01-desktop-tauri-design)."""
import server


def test_defaults_match_todays_behavior():
    a = server.build_parser().parse_args([])
    assert a.host == "127.0.0.1"
    assert a.port == 8765
    assert a.data_dir is None
    assert a.cors_origin == []
    assert a.exit_on_stdin_close is False


def test_flags_parse():
    a = server.build_parser().parse_args(
        ["--host", "0.0.0.0", "--port", "9123", "--data-dir", "/tmp/x",
         "--cors-origin", "http://localhost:1420", "--exit-on-stdin-close"])
    assert a.host == "0.0.0.0"
    assert a.port == 9123
    assert a.data_dir == "/tmp/x"
    assert a.cors_origin == ["http://localhost:1420"]
    assert a.exit_on_stdin_close is True


def test_cors_origin_repeats():
    a = server.build_parser().parse_args(
        ["--cors-origin", "a://b", "--cors-origin", "c://d"])
    assert a.cors_origin == ["a://b", "c://d"]


def test_env_overrides_default(monkeypatch):
    monkeypatch.setenv("NOVEL_TTS_PORT", "7000")
    monkeypatch.setenv("NOVEL_TTS_HOST", "0.0.0.0")
    a = server.build_parser().parse_args([])
    assert a.port == 7000
    assert a.host == "0.0.0.0"


def test_explicit_flag_beats_env(monkeypatch):
    monkeypatch.setenv("NOVEL_TTS_PORT", "7000")
    a = server.build_parser().parse_args(["--port", "8123"])
    assert a.port == 8123
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/test_cli.py -v`
Expected: FAIL — `AttributeError: module 'server' has no attribute 'build_parser'`.

- [ ] **Step 3: Add `build_parser` and the stdin watchdog**

Add near the top of `server.py`, after the existing imports:

```python
import argparse
import os
import sys
```

Add two module-level functions above `def main()`:

```python
def build_parser() -> argparse.ArgumentParser:
    """The sidecar contract. Every default reproduces the pre-flag behavior, so
    `python server.py` and start.sh are unaffected."""
    ap = argparse.ArgumentParser(prog="novel-tts")
    ap.add_argument("--host", default=os.environ.get("NOVEL_TTS_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("NOVEL_TTS_PORT", "8765")))
    ap.add_argument("--data-dir", default=os.environ.get("NOVEL_TTS_DATA_DIR"),
                    help="directory holding novel.txt, state.json, cache/, "
                         "images/, voices/ and wallpaper (default: alongside server.py)")
    ap.add_argument("--cors-origin", action="append", default=[],
                    help="extra allowed Origin; repeatable")
    ap.add_argument("--exit-on-stdin-close", action="store_true",
                    help="exit when stdin reaches EOF (host-process watchdog)")
    return ap


def _watch_stdin():
    """Exit when the parent closes our stdin.

    This is the only teardown mechanism that reaches a Python process running
    inside WSL2, where a Windows job object has no jurisdiction: the pipe closes
    when the host process dies for any reason.
    """
    def wait():
        try:
            while sys.stdin.readline():
                pass
        except Exception:
            pass
        log.info("stdin closed, exiting")
        os._exit(0)
    threading.Thread(target=wait, daemon=True, name="stdin-watchdog").start()
```

- [ ] **Step 4: Rewrite `main()` to use them**

Replace `def main():` and its body (lines 435-456) with:

```python
def main(argv=None):
    import uvicorn
    from tts import EngineManager, TTSWorker

    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # One `root` feeds four consumers that are NOT derived from each other:
    # the state peek, EngineManager (which owns voices/), TTSWorker (cache/),
    # and create_app (novel.txt, state.json, images/, wallpaper). Keeping them
    # on a single variable is what keeps one data directory coherent.
    root = Path(args.data_dir).expanduser().resolve() if args.data_dir else Path(__file__).parent
    root.mkdir(parents=True, exist_ok=True)
    # peek at the persisted engine/mode so a "cpu"-pinned engine never even
    # creates a CUDA context (create_app re-validates and applies it)
    try:
        peek = migrate_state(json.loads((root / "state.json").read_text()))
    except (OSError, json.JSONDecodeError, AttributeError):
        peek = {}
    engine_id = peek.get("engine") if peek.get("engine") in ("kokoro", "qwen3") else "kokoro"
    mode = peek.get("device_mode", "auto")
    try:
        manager = EngineManager(root, engine_id=engine_id, mode=mode)
    except ValueError:                             # e.g. qwen-tts uninstalled since
        manager = EngineManager(root, engine_id="kokoro", mode=mode)
    worker = TTSWorker(root / "cache", manager)
    app = create_app(root, worker, manager=manager, cors_origins=args.cors_origin)
    if args.exit_on_stdin_close:
        _watch_stdin()
    log.info("novel-tts ready: http://%s:%d", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
```

Do **not** try `--port 0`: `uvicorn.run` gives no way to read the bound port back, so port selection has to stay on the Rust side.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_cli.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify no regression and that the old entry point is unchanged**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: `199 passed, 1 failed, 2 deselected`.

Then confirm the no-flags entry point — the one `start.sh` uses — still serves on the original port with the original data dir:

```bash
.venv311/bin/python server.py &
sleep 20 && curl -s http://127.0.0.1:8765/api/engines | head -c 80 && kill %1
```

Expected: the engines JSON.

- [ ] **Step 7: Verify `--data-dir` relocates every runtime path**

```bash
.venv311/bin/python server.py --port 8790 --data-dir /tmp/novel-alt &
sleep 25 && curl -s -X POST http://127.0.0.1:8790/api/doc \
  -H 'Content-Type: application/json' -d '{"text":"Hello there. A second line."}' >/dev/null
sleep 2 && ls /tmp/novel-alt && kill %1
```

Expected: `/tmp/novel-alt` contains `novel.txt`, `state.json`, and `cache/` — and the repo's own `novel.txt`/`state.json` are untouched.

- [ ] **Step 8: Commit**

```bash
git add server.py tests/test_cli.py
git commit -m "feat: sidecar CLI contract - host, port, data dir, stdin watchdog

Lets a host process place the server on a chosen port and data directory.
Every default reproduces the previous behavior, so start.sh is unaffected.
The stdin-EOF watchdog is the only teardown path that reaches a Python
process running inside WSL2."
```

---

### Task 6: Desktop workspace that builds the shared UI

Proves the shared-source approach in the browser before any Rust exists. At the end of this task `npm run dev -w desktop` serves the full app on :1420 against a manually started backend.

**Files:**
- Create: `package.json` (repo root — none exists today)
- Create: `desktop/package.json`, `desktop/vite.config.ts`, `desktop/tsconfig.json`, `desktop/index.html`
- Create: `desktop/src/main.tsx`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `apiUrl` (Task 1), `frontend/public/theme-boot.js` (Task 3).
- Produces: the `desktop` npm workspace, a Vite dev server on **port 1420** (`strictPort`), and `desktop/dist` as the build output. Task 7's `tauri.conf.json` hardcodes both.

- [ ] **Step 1: Create the root workspace file**

`package.json`:

```json
{
  "name": "novel-tts",
  "private": true,
  "workspaces": ["frontend", "desktop"]
}
```

- [ ] **Step 2: Create `desktop/package.json`**

Runtime deps are declared explicitly rather than relying on npm hoisting: `index.css:1-43` resolves `@fontsource-variable/*` through Vite's CSS `@import`, which fails hard if hoisting misses. Keep every version in lockstep with `frontend/package.json`.

```json
{
  "name": "desktop",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@fontsource-variable/bitter": "^5.2.10",
    "@fontsource-variable/caveat": "^5.2.8",
    "@fontsource-variable/crimson-pro": "^5.2.8",
    "@fontsource-variable/dancing-script": "^5.2.8",
    "@fontsource-variable/eb-garamond": "^5.2.7",
    "@fontsource-variable/geist": "^5.2.9",
    "@fontsource-variable/inter": "^5.2.8",
    "@fontsource-variable/jetbrains-mono": "^5.2.8",
    "@fontsource-variable/literata": "^5.2.8",
    "@fontsource-variable/lora": "^5.2.8",
    "@fontsource-variable/merriweather": "^5.2.6",
    "@fontsource-variable/nunito": "^5.2.7",
    "@fontsource/atkinson-hyperlegible": "^5.2.8",
    "@fontsource/averia-serif-libre": "^5.2.7",
    "@fontsource/comic-neue": "^5.2.7",
    "@fontsource/courier-prime": "^5.2.8",
    "@fontsource/patrick-hand": "^5.2.8",
    "@tailwindcss/vite": "^4.3.2",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cmdk": "^1.1.1",
    "lucide-react": "^1.24.0",
    "motion": "^12.42.2",
    "radix-ui": "^1.6.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "shadcn": "^4.13.0",
    "sonner": "^2.0.7",
    "tailwind-merge": "^3.6.0",
    "tailwindcss": "^4.3.2",
    "tw-animate-css": "^1.4.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.11.4",
    "@types/node": "^24.13.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.3",
    "typescript": "~6.0.2",
    "vite": "^8.1.1"
  }
}
```

- [ ] **Step 3: Create `desktop/vite.config.ts`**

```ts
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The desktop app compiles the SAME React tree as the web app: `@` points at
// ../frontend/src and publicDir at ../frontend/public. Only main.tsx and the
// Tauri glue are local to this workspace.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../frontend/src"),
      "@desktop": path.resolve(__dirname, "./src"),
    },
  },
  publicDir: path.resolve(__dirname, "../frontend/public"),
  // NEVER "../static": frontend/vite.config.ts builds there with
  // emptyOutDir, and would delete the web app's bundle.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // index.css uses oklch()/color-mix() and watermark.ts uses a regex
    // lookbehind, so safari13 (the Tauri template default) is far too low.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari16",
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    // Dev-only convenience so the app works in a plain browser before the
    // Rust shell injects a base URL.
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
})
```

- [ ] **Step 4: Create `desktop/tsconfig.json`**

Mirrors `frontend/tsconfig.app.json` but resolves `@/*` across the workspace boundary and includes both trees:

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM"],
    "module": "esnext",
    "types": ["vite/client"],
    "allowArbitraryExtensions": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "paths": {
      "@/*": ["../frontend/src/*"],
      "@desktop/*": ["./src/*"]
    }
  },
  "include": ["src", "../frontend/src"]
}
```

- [ ] **Step 5: Create `desktop/index.html`**

Same head as `frontend/index.html`, including the favicon and the `theme-color` meta that `theme.ts:132-134` writes to, and `class="dark"` which `index.css` keys off:

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📖</text></svg>" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#131316" />
    <title>novel-tts</title>
    <script src="/theme-boot.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5b: Create `desktop/src/index.css` — required, not optional**

Tailwind's class scanner does **not** follow the Vite `@` alias across the workspace
boundary. The alias resolves JS/TS imports; there is no CSS-scanning equivalent, so
without an explicit source directive the desktop build emits 8 selectors where the web
build emits 311, and the app renders completely unstyled.

```css
@import "../../frontend/src/index.css";
@source "../../frontend/src";
```

`@source` paths resolve relative to the CSS file containing them, so from `desktop/src/`
this lands on `<repo>/frontend/src`.

**Verify with numbers.** After building, compare `desktop/dist/assets/*.css` against
`static/assets/*.css`: selector count, rule count and byte size should be in the same
ballpark, and `.flex`, `.items-center`, `rounded-lg` and a `data-[state` selector must all
be present. A build that succeeds proves nothing here — only the selector count does.

- [ ] **Step 6: Create `desktop/src/main.tsx`**

For now this is the web entry point; Task 12 replaces the render call with the Boot gate.
Note it imports the **desktop-local** stylesheet from Step 5b, not `@/index.css`.

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import "@desktop/index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 6b: Delete `frontend/package-lock.json`**

Once `frontend` is a workspace member the root lockfile is authoritative. A stale nested
lockfile invites a future `cd frontend && npm ci` to install an independently-pinned,
diverging dependency set — silently defeating the shared-`node_modules` model this whole
task depends on.

```bash
git rm frontend/package-lock.json
npm install   # confirm the root lockfile still resolves cleanly
```

- [ ] **Step 7: Update `.gitignore`**

Append:

```
node_modules/
desktop/dist/
desktop/src-tauri/target/
desktop/src-tauri/gen/
```

- [ ] **Step 8: Install and build**

```bash
npm install
npm run build -w desktop
```

Expected: `tsc -b` clean, `desktop/dist/` produced.

- [ ] **Step 9: Verify the shared UI actually renders**

```bash
.venv311/bin/python server.py &
npm run dev -w desktop
```

Open `http://localhost:1420`.
Expected: the full app — top bar, reader, player bar — reading the same `novel.txt` as `http://localhost:8765`. Play a chunk, open settings, change the theme and font. All of it should work, because it is the same code.

- [ ] **Step 10: Verify the web build is still intact**

Run: `npm run build -w frontend && ls static/index.html static/theme-boot.js`
Expected: both exist. The desktop build must not have touched `static/`.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json .gitignore desktop/package.json \
        desktop/vite.config.ts desktop/tsconfig.json desktop/index.html \
        desktop/src/main.tsx
git commit -m "feat: desktop workspace building the shared React tree

npm workspace whose Vite config aliases @ into ../frontend/src, so the desktop
app compiles the same components as the web app rather than a copy. Builds to
desktop/dist, never ../static."
```

---

### Task 7: Tauri shell with base-URL injection

The first Rust. At the end of this task a real desktop window renders the app against a manually started backend, proving the `tauri://localhost` origin, CORS, and base-URL injection all work together end to end.

**Files:**
- Create: `desktop/src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, `src/lib.rs`, `src/window.rs`
- Create: `desktop/src-tauri/icons/` (generated)

**Interfaces:**
- Consumes: `window.__API_BASE__` (Task 1), `desktop/dist` and dev port 1420 (Task 6).
- Produces: `inject_api_base(window: &tauri::WebviewWindow, base: &str)` in `window.rs`, and the managed-state pattern later tasks extend.

- [ ] **Step 1: Create `desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "novel-tts-desktop"
version = "0.1.0"
description = "novel-tts desktop shell"
edition = "2021"
rust-version = "1.77.2"

[lib]
name = "novel_tts_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
codegen-units = 1
lto = true
opt-level = 3
strip = true
# NOT "abort" (the create-tauri-app default): RunEvent::Exit must still run on
# a panic so the backend child gets killed.
panic = "unwind"
```

- [ ] **Step 2: Create `desktop/src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Generate icons**

Tauri will not build without them.

```bash
cd desktop && npx tauri icon
```

If that needs a source image, create a 1024×1024 PNG of the 📖 glyph first and pass it: `npx tauri icon path/to/icon.png`.

- [ ] **Step 4: Create `desktop/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "novel-tts",
  "version": "0.1.0",
  "identifier": "dev.kuon.novel-tts",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev -w desktop",
    "beforeBuildCommand": "npm run build -w desktop"
  },
  "app": {
    "windows": [
      {
        "title": "novel-tts",
        "width": 1200,
        "height": 860,
        "minWidth": 1024,
        "minHeight": 600,
        "resizable": true,
        "visible": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "13.3"
    }
  }
}
```

`csp` stays `null` on purpose: Tauri injects no policy by default, and adding one here can only break the app (sonner injects styles at runtime, and Vite inlines two woff2 faces as data URIs). `minWidth` sits above the Tailwind `lg` breakpoint so the volume slider, time column, and realtime readout never hide.

- [ ] **Step 5: Create `desktop/src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

No `shell:` permissions at any point — the webview never spawns anything.

- [ ] **Step 6: Create `desktop/src-tauri/src/window.rs`**

```rust
use tauri::WebviewWindow;

/// Publish the Python server's origin to the webview.
///
/// `apiUrl()` in frontend/src/lib/api.ts reads `window.__API_BASE__` at CALL
/// time, so this may land after the bundle has been evaluated. The value must
/// be a bare origin with no trailing slash: player.ts compares
/// `audio.src.endsWith(audioUrl(cid))`.
pub fn inject_api_base(window: &WebviewWindow, base: &str) -> tauri::Result<()> {
    let js = format!(
        "window.__API_BASE__ = {};",
        serde_json::to_string(base).expect("string always serializes")
    );
    window.eval(&js)
}
```

- [ ] **Step 7: Create `desktop/src-tauri/src/lib.rs`**

For this task the base URL is the fixed default port; Tasks 9-12 replace that with real discovery.

```rust
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
```

- [ ] **Step 8: Create `desktop/src-tauri/src/main.rs`**

```rust
// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    novel_tts_desktop_lib::run()
}
```

- [ ] **Step 9: Run it against a live backend**

```bash
.venv311/bin/python server.py &
npm run tauri dev -w desktop
```

Expected: a native window opens showing the reader. **This is the end-to-end proof** — it only works if Task 1's injection point, Task 4's CORS, and Task 6's shared build are all correct.

- [ ] **Step 10: Verify the cross-origin paths specifically**

In the running window: play a chunk (audio element, cross-origin WAV), set a wallpaper (POST with an `image/*` content type, i.e. preflighted), then remove it (DELETE, i.e. preflighted).
Expected: all three work. If the wallpaper silently fails to appear, CORS is wrong, not the UI.

- [ ] **Step 11: Commit**

```bash
git add desktop/src-tauri/
git commit -m "feat: Tauri shell rendering the shared UI against the backend

First working desktop window. Injects the server origin as window.__API_BASE__,
which apiUrl() reads at call time. panic=unwind rather than the template
default so exit hooks still run. CSP stays null - Tauri injects none and one
would only break sonner's runtime styles."
```

---

### Task 8: Desktop settings

A typed, validated Rust struct rather than `tauri-plugin-store`: these fields are the direct inputs to a process spawn, so the webview must not be able to rewrite them key by key.

**Files:**
- Create: `desktop/src-tauri/src/settings.rs`
- Modify: `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `DesktopSettings` (fields below), `BackendMode`, `DesktopSettings::load(&AppHandle) -> DesktopSettings`, `DesktopSettings::save(&self, &AppHandle) -> std::io::Result<()>`, `DesktopSettings::resolve_python(&self) -> Result<PathBuf, String>`. Tasks 10 and 14 consume these exact names.

- [ ] **Step 1: Write the failing test**

Append to `desktop/src-tauri/src/settings.rs` (created in the next step; write the test first and let it fail to compile):

```rust
#[cfg(test)]
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop/src-tauri && cargo test`
Expected: FAIL to compile — `DesktopSettings` not found.

- [ ] **Step 3: Implement `settings.rs`**

```rust
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
```

- [ ] **Step 4: Register the module**

Add `mod settings;` to the top of `desktop/src-tauri/src/lib.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/settings.rs desktop/src-tauri/src/lib.rs
git commit -m "feat: desktop settings struct with atomic writes

Typed serde struct in app_config_dir rather than tauri-plugin-store: these
fields become process arguments, so the webview must not be able to rewrite
them piecemeal. Defaults prefer .venv311 over .venv, since .venv is 3.14
without torch."
```

---

### Task 9: Backend discovery — probe, classify, pick a port

Decides whether to attach to a running server, spawn on the configured port, or move aside for a foreign process. Shape-checking the response is mandatory: attaching to whatever holds 8765 would point the reader at an unrelated process.

**Files:**
- Create: `desktop/src-tauri/src/backend/mod.rs`, `desktop/src-tauri/src/backend/discover.rs`
- Modify: `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `Probe` (`Free` | `NovelTts` | `Foreign`), `probe(port: u16) -> Probe`, `pick_free_port() -> std::io::Result<u16>`, `http_get_json(port: u16, path: &str, timeout: Duration) -> Result<serde_json::Value, String>`. Task 11 reuses `http_get_json` for readiness polling.

- [ ] **Step 1: Write the failing test**

Create `desktop/src-tauri/src/backend/discover.rs` with the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// Serve one canned HTTP response and close, mimicking uvicorn's behavior
    /// when the request carries `Connection: close`.
    fn serve_once(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        port
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn nothing_listening_is_free() {
        assert!(matches!(probe(free_port()), Probe::Free));
    }

    #[test]
    fn a_novel_tts_shaped_response_is_ours() {
        let port = serve_once(
            r#"{"engines":[{"id":"kokoro","supported_modes":["auto"]}],"current":"kokoro"}"#,
        );
        assert!(matches!(probe(port), Probe::NovelTts));
    }

    #[test]
    fn a_different_json_service_is_foreign() {
        let port = serve_once(r#"{"hello":"world"}"#);
        assert!(matches!(probe(port), Probe::Foreign));
    }

    #[test]
    fn engines_without_the_expected_entry_shape_is_foreign() {
        let port = serve_once(r#"{"engines":[{"name":"x"}],"current":"x"}"#);
        assert!(matches!(probe(port), Probe::Foreign));
    }

    #[test]
    fn pick_free_port_returns_a_bindable_port() {
        let p = pick_free_port().unwrap();
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop/src-tauri && cargo test`
Expected: FAIL to compile — `probe` not found.

- [ ] **Step 3: Implement `discover.rs`**

Prepend this above the test module:

```rust
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const READ_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// Nothing is listening; safe to spawn here.
    Free,
    /// A novel-tts server is listening; attach to it.
    NovelTts,
    /// Something else holds the port; move aside.
    Foreign,
}

/// Minimal blocking HTTP/1.1 GET against localhost.
///
/// Hand-rolled rather than pulling in an HTTP client: the only requests this
/// app makes are localhost JSON GETs. `Connection: close` makes uvicorn close
/// the socket after responding, so read-to-EOF terminates instead of hanging
/// on keep-alive.
pub fn http_get_json(
    port: u16,
    path: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut sock = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("connect: {e}"))?;
    sock.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    sock.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;

    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Accept: application/json\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;

    let mut raw = Vec::new();
    sock.read_to_end(&mut raw).map_err(|e| format!("read: {e}"))?;

    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "malformed response: no header terminator".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status_ok = head
        .lines()
        .next()
        .map(|l| l.contains(" 200"))
        .unwrap_or(false);
    if !status_ok {
        return Err(format!("non-200 response: {}", head.lines().next().unwrap_or("")));
    }
    serde_json::from_slice(&raw[split + 4..]).map_err(|e| format!("json: {e}"))
}

/// Classify whatever is on `port`.
///
/// GET /api/engines is the right probe: it is lock-free on the server side
/// (tts/registry.py uses importlib.util.find_spec, tts/manager.py exposes
/// engine_id as a plain property), so it cannot block behind an in-flight
/// synthesize. /api/doc and /api/voices both take st.lock; /api/audio blocks
/// for up to 30s.
pub fn probe(port: u16) -> Probe {
    let value = match http_get_json(port, "/api/engines", READ_TIMEOUT) {
        Ok(v) => v,
        Err(e) if e.starts_with("connect:") => return Probe::Free,
        Err(_) => return Probe::Foreign,
    };
    if is_novel_tts(&value) {
        Probe::NovelTts
    } else {
        Probe::Foreign
    }
}

/// Shape check. Attaching on a bare 200 would point the reader at an unrelated
/// process that merely happens to hold the port.
fn is_novel_tts(v: &serde_json::Value) -> bool {
    let has_current = v.get("current").and_then(|c| c.as_str()).is_some();
    let entries_ok = v
        .get("engines")
        .and_then(|e| e.as_array())
        .map(|arr| {
            !arr.is_empty()
                && arr.iter().all(|e| {
                    e.get("id").and_then(|i| i.as_str()).is_some()
                        && e.get("supported_modes").and_then(|m| m.as_array()).is_some()
                })
        })
        .unwrap_or(false);
    has_current && entries_ok
}

/// Ask the OS for an unused port. There is an unavoidable TOCTOU window
/// between this and the child's bind; callers retry.
pub fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}
```

- [ ] **Step 4: Create `desktop/src-tauri/src/backend/mod.rs`**

```rust
pub mod discover;
```

- [ ] **Step 5: Register the module**

Add `mod backend;` to `desktop/src-tauri/src/lib.rs`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test`
Expected: PASS, 9 tests total.

- [ ] **Step 7: Verify against the real server**

```bash
.venv311/bin/python server.py &
cd desktop/src-tauri && cargo test -- --ignored --nocapture
```

Then add and run this one-off check (delete it afterwards) or confirm manually with `curl -s http://127.0.0.1:8765/api/engines | head -c 120` that the JSON has both `engines[].id` and `current`.

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/src/backend/ desktop/src-tauri/src/lib.rs
git commit -m "feat: backend discovery - probe, shape-check, pick a port

GET /api/engines is the probe because it is lock-free server-side and cannot
block behind an in-flight synthesize. The response is shape-checked before we
call it ours: attaching on a bare 200 would point the reader at whatever
happens to hold the port. Hand-rolled HTTP with Connection: close rather than
an HTTP-client dependency."
```

---

### Task 10: Launch spec — argv for native and WSL

Pure argv construction, kept separate from spawning so it is testable without starting processes.

**Files:**
- Create: `desktop/src-tauri/src/backend/launch.rs`
- Modify: `desktop/src-tauri/src/backend/mod.rs`

**Interfaces:**
- Consumes: `DesktopSettings`, `BackendMode` (Task 8); the CLI contract (Task 5).
- Produces: `LaunchSpec { program: String, args: Vec<String>, cwd: Option<PathBuf>, env: Vec<(String, String)> }` and `build_launch_spec(&DesktopSettings, port: u16, dev: bool) -> Result<LaunchSpec, String>`. Task 11 spawns exactly this.

- [ ] **Step 1: Write the failing test**

Create `desktop/src-tauri/src/backend/launch.rs` with the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{BackendMode, DesktopSettings};

    fn native() -> DesktopSettings {
        let mut s = DesktopSettings::default();
        s.repo_dir = std::env::temp_dir().join("novel-repo");
        std::fs::create_dir_all(&s.repo_dir).unwrap();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop/src-tauri && cargo test`
Expected: FAIL to compile — `build_launch_spec` not found.

- [ ] **Step 3: Implement `launch.rs`**

Prepend above the test module:

```rust
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
```

- [ ] **Step 4: Register the module**

Add `pub mod launch;` to `desktop/src-tauri/src/backend/mod.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test`
Expected: PASS, 17 tests total.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/backend/launch.rs desktop/src-tauri/src/backend/mod.rs
git commit -m "feat: launch spec for native and WSL backends

Pure argv construction, separated from spawning so it is testable without
starting processes. WSL goes through wsl.exe --exec to avoid a shell layer,
and always carries --exit-on-stdin-close because a Windows job object cannot
reach inside the WSL VM."
```

---

### Task 11: Spawn and supervise the child

Spawns through `std::process::Command`, not `tauri-plugin-shell`: the plugin exposes no OS spawn controls and its exit cleanup only kills children registered through the JS IPC path, so a Rust-spawned child would be neither tracked nor killed.

**Files:**
- Create: `desktop/src-tauri/src/backend/supervise.rs`
- Modify: `desktop/src-tauri/src/backend/mod.rs`, `desktop/src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `LaunchSpec` (Task 10).
- Produces: `LogLine { stream: String, text: String }`, `BackendChild` with `spawn(&LaunchSpec) -> std::io::Result<BackendChild>`, `.logs() -> Vec<LogLine>`, `.close_stdin()`, `.try_wait()`, `.kill_tree()`, and `.pid()`. Tasks 12 and 13 consume these.

- [ ] **Step 1: Add the platform dependencies**

Append to `desktop/src-tauri/Cargo.toml`:

```toml
[target.'cfg(unix)'.dependencies]
libc = "0.2"

[target.'cfg(windows)'.dependencies]
win32job = "2"
```

- [ ] **Step 2: Write the failing test**

Create `desktop/src-tauri/src/backend/supervise.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn echo_spec(script: &str) -> LaunchSpec {
        LaunchSpec {
            program: if cfg!(windows) { "cmd".into() } else { "sh".into() },
            args: if cfg!(windows) {
                vec!["/C".into(), script.into()]
            } else {
                vec!["-c".into(), script.into()]
            },
            cwd: None,
            env: vec![],
        }
    }

    #[test]
    fn captures_stdout_and_stderr() {
        let child = BackendChild::spawn(&echo_spec("echo hello; echo oops 1>&2")).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let logs = child.logs();
        assert!(logs.iter().any(|l| l.text.contains("hello") && l.stream == "stdout"));
        assert!(logs.iter().any(|l| l.text.contains("oops") && l.stream == "stderr"));
    }

    #[test]
    fn ring_buffer_is_bounded() {
        let child = BackendChild::spawn(&echo_spec(
            "i=0; while [ $i -lt 2500 ]; do echo line$i; i=$((i+1)); done",
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(child.logs().len() <= LOG_RING_CAPACITY);
    }

    #[test]
    fn closing_stdin_ends_a_child_that_watches_it() {
        // mimics server.py's _watch_stdin: read until EOF, then exit
        let mut child = BackendChild::spawn(&echo_spec("cat > /dev/null")).unwrap();
        child.close_stdin();
        for _ in 0..50 {
            if child.try_wait().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("child did not exit after stdin closed");
    }

    #[test]
    fn kill_tree_stops_a_running_child() {
        let mut child = BackendChild::spawn(&echo_spec("sleep 30")).unwrap();
        child.kill_tree();
        for _ in 0..50 {
            if child.try_wait().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("child survived kill_tree");
    }
}
```

The `sh`-specific tests are skipped on Windows by the `cfg!(windows)` branch selecting `cmd`; note in review that `cat`/`sleep` differ there, so run this suite on macOS.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd desktop/src-tauri && cargo test`
Expected: FAIL to compile — `BackendChild` not found.

- [ ] **Step 4: Implement `supervise.rs`**

Prepend above the tests:

```rust
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::launch::LaunchSpec;

/// Enough scrollback for a reloaded webview to backfill a failed startup.
pub const LOG_RING_CAPACITY: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub stream: String,
    pub text: String,
}

pub struct BackendChild {
    child: Child,
    logs: Arc<Mutex<VecDeque<LogLine>>>,
    #[cfg(windows)]
    _job: Option<win32job::Job>,
}

impl BackendChild {
    pub fn spawn(spec: &LaunchSpec) -> std::io::Result<Self> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        // Own the whole process tree so teardown can reach grandchildren.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()?;

        // A job object with KILL_ON_JOB_CLOSE is the only layer that survives
        // a Rust panic or Task Manager killing us.
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            win32job::Job::create()
                .and_then(|j| {
                    let mut info = j.query_extended_limit_info()?;
                    info.limit_kill_on_job_close();
                    j.set_extended_limit_info(&mut info)?;
                    j.assign_process(child.as_raw_handle() as _)?;
                    Ok(j)
                })
                .ok()
        };

        let logs = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_RING_CAPACITY)));
        if let Some(out) = child.stdout.take() {
            Self::pump(out, "stdout", Arc::clone(&logs));
        }
        if let Some(err) = child.stderr.take() {
            Self::pump(err, "stderr", Arc::clone(&logs));
        }

        Ok(Self {
            child,
            logs,
            #[cfg(windows)]
            _job: job,
        })
    }

    fn pump<R: std::io::Read + Send + 'static>(
        reader: R,
        stream: &'static str,
        logs: Arc<Mutex<VecDeque<LogLine>>>,
    ) {
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                let mut guard = match logs.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if guard.len() == LOG_RING_CAPACITY {
                    guard.pop_front();
                }
                guard.push_back(LogLine { stream: stream.to_string(), text: line });
            }
        });
    }

    pub fn logs(&self) -> Vec<LogLine> {
        self.logs.lock().map(|g| g.iter().cloned().collect()).unwrap_or_default()
    }

    /// Last N lines, for the startup screen's failure display.
    pub fn log_tail(&self, n: usize) -> Vec<LogLine> {
        let all = self.logs();
        all[all.len().saturating_sub(n)..].to_vec()
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Drop the write end of the child's stdin. server.py's --exit-on-stdin-close
    /// watchdog sees EOF and exits. This is teardown layer 1.
    pub fn close_stdin(&mut self) {
        self.child.stdin.take();
    }

    pub fn try_wait(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Teardown layer 2: signal the whole process group, escalating after a
    /// grace period.
    pub fn kill_tree(&mut self) {
        #[cfg(unix)]
        {
            let pgid = self.child.id() as i32;
            unsafe { libc::killpg(pgid, libc::SIGTERM) };
            for _ in 0..20 {
                if self.try_wait().is_some() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
```

- [ ] **Step 5: Register the module**

Add `pub mod supervise;` to `desktop/src-tauri/src/backend/mod.rs`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test`
Expected: PASS, 21 tests total.

- [ ] **Step 7: Verify no orphan is left behind**

```bash
cd desktop/src-tauri && cargo test kill_tree -- --nocapture
ps aux | grep -c "[s]leep 30"
```

Expected: `0`.

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/src/backend/supervise.rs \
        desktop/src-tauri/src/backend/mod.rs desktop/src-tauri/Cargo.toml
git commit -m "feat: spawn and supervise the backend child

std::process::Command rather than tauri-plugin-shell: the plugin exposes no
process-group or job-object controls, and its exit cleanup only kills children
registered through the JS IPC path. Unix gets a process group, Windows a job
object with KILL_ON_JOB_CLOSE. Logs land in a bounded ring buffer."
```

---

### Task 12: Readiness state machine and the startup screen

Ties discovery, launch, and supervision together into one observable lifecycle, and gives the user something to look at during a cold start that can legitimately take minutes.

**Files:**
- Create: `desktop/src-tauri/src/backend/health.rs`, `desktop/src-tauri/src/commands.rs`
- Create: `desktop/src/Boot.tsx`, `desktop/src/desktop.ts`
- Modify: `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/backend/mod.rs`, `desktop/src/main.tsx`, `desktop/package.json`

**Interfaces:**
- Consumes: `probe`, `pick_free_port`, `http_get_json` (Task 9); `build_launch_spec` (Task 10); `BackendChild` (Task 11); `inject_api_base` (Task 7).
- Produces: the `backend://state` event carrying `BackendState { phase, base, elapsed_s, message, log_tail }` where `phase` is one of `discovering` | `spawning` | `waiting` | `ready` | `attached` | `failed` | `exited`; the `restart_backend` command; and `BackendHandle` in managed state.

- [ ] **Step 1: Add the JS API package**

```bash
npm install -D @tauri-apps/api@2.11.1 -w desktop
```

- [ ] **Step 2: Implement `desktop/src-tauri/src/backend/health.rs`**

```rust
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::discover::{http_get_json, pick_free_port, probe, Probe};
use super::launch::build_launch_spec;
use super::supervise::{BackendChild, LogLine};
use crate::settings::DesktopSettings;
use crate::window;

/// A cold start can include a torch import, a 313MB Kokoro download, or a
/// ~1.8GB Qwen3 variant. Minutes, not seconds.
const READY_DEADLINE: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const SPAWN_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendState {
    pub phase: String,
    pub base: Option<String>,
    pub elapsed_s: u64,
    pub message: Option<String>,
    pub log_tail: Vec<LogLine>,
    /// False in attach mode: we did not spawn it, so we must not kill it.
    pub owned: bool,
}

impl BackendState {
    fn phase(phase: &str) -> Self {
        Self {
            phase: phase.to_string(),
            base: None,
            elapsed_s: 0,
            message: None,
            log_tail: vec![],
            owned: false,
        }
    }
}

#[derive(Default)]
pub struct BackendHandle {
    pub child: Mutex<Option<BackendChild>>,
    pub state: Mutex<Option<BackendState>>,
}

fn emit(app: &AppHandle, state: BackendState) {
    if let Ok(mut slot) = app.state::<Arc<BackendHandle>>().state.lock() {
        *slot = Some(state.clone());
    }
    let _ = app.emit("backend://state", state);
}

/// Full lifecycle. Runs on a worker thread so it never blocks the UI.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(message) = run(&app) {
            let mut failed = BackendState::phase("failed");
            failed.message = Some(message);
            failed.log_tail = current_tail(&app, 20);
            emit(&app, failed);
        }
    });
}

fn current_tail(app: &AppHandle, n: usize) -> Vec<LogLine> {
    app.state::<Arc<BackendHandle>>()
        .child
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.log_tail(n)))
        .unwrap_or_default()
}

fn run(app: &AppHandle) -> Result<(), String> {
    emit(app, BackendState::phase("discovering"));
    let settings = DesktopSettings::load(app);
    let dev = cfg!(debug_assertions);

    // 1. Attach to an existing novel-tts rather than racing it on state.json.
    if probe(settings.port) == Probe::NovelTts {
        let base = format!("http://127.0.0.1:{}", settings.port);
        let mut st = BackendState::phase("attached");
        st.base = Some(base.clone());
        st.owned = false;
        st.message = Some("attached to a server started elsewhere".into());
        publish(app, &base)?;
        emit(app, st);
        return Ok(());
    }

    // 2. Otherwise pick a port we can actually have.
    let mut last_err = String::new();
    for attempt in 0..SPAWN_ATTEMPTS {
        let port = if probe(settings.port) == Probe::Free {
            settings.port
        } else {
            pick_free_port().map_err(|e| format!("no free port: {e}"))?
        };

        emit(app, BackendState::phase("spawning"));
        let spec = build_launch_spec(&settings, port, dev)?;
        let child = match BackendChild::spawn(&spec) {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("spawn failed ({}): {e}", spec.program);
                continue;
            }
        };
        {
            let handle = app.state::<Arc<BackendHandle>>();
            *handle.child.lock().map_err(|_| "state poisoned")? = Some(child);
        }

        match wait_ready(app, port) {
            Ok(()) => {
                let base = format!("http://127.0.0.1:{port}");
                publish(app, &base)?;
                let mut st = BackendState::phase("ready");
                st.base = Some(base);
                st.owned = true;
                emit(app, st);
                watch_for_exit(app.clone());
                return Ok(());
            }
            Err(e) => {
                last_err = e;
                if let Ok(mut slot) = app.state::<Arc<BackendHandle>>().child.lock() {
                    if let Some(c) = slot.as_mut() {
                        c.kill_tree();
                    }
                    *slot = None;
                }
                // Only a bind race is worth retrying; a bad interpreter would
                // spin forever.
                if attempt + 1 < SPAWN_ATTEMPTS && last_err.contains("exited") {
                    continue;
                }
                break;
            }
        }
    }
    Err(last_err)
}

fn wait_ready(app: &AppHandle, port: u16) -> Result<(), String> {
    let started = Instant::now();
    loop {
        // A child that already died will never become ready.
        {
            let handle = app.state::<Arc<BackendHandle>>();
            let mut slot = handle.child.lock().map_err(|_| "state poisoned")?;
            if let Some(child) = slot.as_mut() {
                if let Some(status) = child.try_wait() {
                    return Err(format!("backend exited early ({status})"));
                }
            }
        }
        if http_get_json(port, "/api/engines", Duration::from_millis(1500)).is_ok() {
            return Ok(());
        }
        let elapsed = started.elapsed();
        if elapsed > READY_DEADLINE {
            return Err(format!(
                "backend did not become ready within {}s",
                READY_DEADLINE.as_secs()
            ));
        }
        let mut st = BackendState::phase("waiting");
        st.elapsed_s = elapsed.as_secs();
        st.log_tail = current_tail(app, 20);
        emit(app, st);
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn publish(app: &AppHandle, base: &str) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    window::inject_api_base(&win, base).map_err(|e| e.to_string())
}

/// Surface an unexpected death. Deliberately does NOT respawn in a loop: an
/// ImportError would spin forever.
fn watch_for_exit(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let handle = app.state::<Arc<BackendHandle>>();
        let dead = {
            let mut slot = match handle.child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match slot.as_mut() {
                Some(child) => child.try_wait().is_some(),
                None => return,
            }
        };
        if dead {
            let mut st = BackendState::phase("exited");
            st.message = Some("the backend process stopped".into());
            st.log_tail = current_tail(&app, 20);
            emit(&app, st);
            return;
        }
    });
}
```

- [ ] **Step 3: Implement `desktop/src-tauri/src/commands.rs`**

```rust
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
```

- [ ] **Step 4: Wire it into `lib.rs`**

Replace the body of `run()`:

```rust
mod backend;
mod commands;
mod settings;
mod window;

use std::sync::Arc;

use backend::health::BackendHandle;

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Add `pub mod health;` to `desktop/src-tauri/src/backend/mod.rs`. Remove the placeholder `inject_api_base` call added in Task 7 — `health::publish` owns it now. Add `use tauri::Manager;` where needed.

- [ ] **Step 5: Create `desktop/src/desktop.ts`**

```ts
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface LogLine {
  stream: string
  text: string
}

export interface BackendState {
  phase: "discovering" | "spawning" | "waiting" | "ready" | "attached" | "failed" | "exited"
  base: string | null
  elapsedS: number
  message: string | null
  logTail: LogLine[]
  owned: boolean
}

export const onBackendState = (fn: (s: BackendState) => void) =>
  listen<BackendState>("backend://state", (e) => fn(e.payload))

export const getBackendState = () => invoke<BackendState | null>("get_backend_state")
export const restartBackend = () => invoke<void>("restart_backend")
```

- [ ] **Step 6: Create `desktop/src/Boot.tsx`**

```tsx
import { useEffect, useState } from "react"
import { getBackendState, onBackendState, restartBackend, type BackendState } from "@desktop/desktop"

const COPY: Record<BackendState["phase"], string> = {
  discovering: "Looking for a running server…",
  spawning: "Starting the TTS backend…",
  waiting: "Waiting for the backend to come up…",
  ready: "Ready",
  attached: "Attached to a server started elsewhere",
  failed: "The backend could not be started",
  exited: "The backend stopped",
}

export function Boot({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BackendState | null>(null)

  useEffect(() => {
    getBackendState().then((s) => s && setState(s))
    const un = onBackendState(setState)
    return () => {
      un.then((f) => f())
    }
  }, [])

  if (state && (state.phase === "ready" || state.phase === "attached")) return <>{children}</>

  const failed = state?.phase === "failed" || state?.phase === "exited"
  const slow = (state?.elapsedS ?? 0) > 20

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
      <div className="w-full max-w-xl rounded-xl border bg-card p-6 shadow-sm">
        <p className="font-mono text-sm text-muted-foreground">novel-tts</p>
        <h1 className="mt-2 text-lg font-medium">{state ? COPY[state.phase] : COPY.discovering}</h1>

        {state?.message && <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>}

        {!failed && slow && (
          <p className="mt-2 text-sm text-muted-foreground">
            This can take several minutes on the first run — it downloads model weights.
            {state?.elapsedS ? ` (${state.elapsedS}s)` : ""}
          </p>
        )}

        {!!state?.logTail?.length && (
          <details className="mt-4" open={failed}>
            <summary className="cursor-pointer text-sm text-muted-foreground">Backend output</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {state.logTail.map((l, i) => (
                <div key={i} className={l.stream === "stderr" ? "text-destructive" : undefined}>
                  {l.text}
                </div>
              ))}
            </pre>
          </details>
        )}

        {failed && (
          <button
            type="button"
            onClick={() => restartBackend()}
            className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Gate the app on Boot in `desktop/src/main.tsx`**

Gating here also guarantees `player.start()` (`App.tsx:27-29`) never runs before the base URL exists.

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import "@/index.css"
import { Boot } from "@desktop/Boot"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot>
      <App />
    </Boot>
  </StrictMode>,
)
```

- [ ] **Step 8: Verify the spawn path**

Make sure nothing is on 8765, then:

```bash
npm run tauri dev -w desktop
```

Expected: the startup screen appears, backend output streams into the details block, and the reader replaces it once ready. `ps aux | grep server.py` shows a child owned by the app.

- [ ] **Step 9: Verify the attach path**

```bash
.venv311/bin/python server.py &
npm run tauri dev -w desktop
```

Expected: "Attached to a server started elsewhere", and no second `server.py` process.

- [ ] **Step 10: Verify the failure path**

Temporarily point `python` at a bad path in `~/Library/Application Support/dev.kuon.novel-tts/settings.json`, relaunch.
Expected: the failed screen with the interpreter error and a working Retry button — not a spinner.

- [ ] **Step 11: Commit**

```bash
git add desktop/src-tauri/src/backend/health.rs desktop/src-tauri/src/commands.rs \
        desktop/src-tauri/src/backend/mod.rs desktop/src-tauri/src/lib.rs \
        desktop/src/Boot.tsx desktop/src/desktop.ts desktop/src/main.tsx \
        desktop/package.json package-lock.json
git commit -m "feat: backend lifecycle and startup screen

Discover-or-attach, spawn, poll GET /api/engines until ready, stream logs into
a startup screen that survives a multi-minute cold start. Attach mode records
owned=false so teardown never kills a server we did not spawn. An unexpected
exit surfaces the stderr tail instead of respawning in a loop."
```

---

### Task 13: Teardown ladder

Four layers, because no single mechanism covers every way an app can die.

**Files:**
- Create: `desktop/src-tauri/src/backend/teardown.rs`
- Modify: `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/backend/mod.rs`

**Interfaces:**
- Consumes: `BackendHandle`, `BackendState.owned` (Task 12); `BackendChild::close_stdin`/`kill_tree` (Task 11).
- Produces: `shutdown(app: &AppHandle)`, called from `RunEvent::ExitRequested` and `RunEvent::Exit`.

- [ ] **Step 1: Implement `teardown.rs`**

```rust
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::health::BackendHandle;

const CLEAN_EXIT_GRACE: Duration = Duration::from_secs(3);

/// Stop the backend we own.
///
/// Layer 1 here (close stdin, wait) and layer 2 (killpg / job terminate).
/// Layer 3 is the Windows job object's KILL_ON_JOB_CLOSE, which fires even if
/// this function never runs. Layer 4 is server.py's own stdin watchdog, the
/// only one that reaches inside a WSL2 VM.
///
/// In attach mode this is a no-op: we did not start that server, so it is not
/// ours to stop.
pub fn shutdown(app: &AppHandle) {
    let owned = app
        .state::<Arc<BackendHandle>>()
        .state
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.owned))
        .unwrap_or(false);
    if !owned {
        return;
    }

    let handle = app.state::<Arc<BackendHandle>>();
    let mut slot = match handle.child.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(child) = slot.as_mut() else { return };

    // L1: EOF on stdin — the child's watchdog exits cleanly.
    child.close_stdin();
    let deadline = Instant::now() + CLEAN_EXIT_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().is_some() {
            *slot = None;
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // L2: escalate through the process group / job object.
    child.kill_tree();
    *slot = None;
}
```

- [ ] **Step 2: Register the module and the run-event ladder**

Add `pub mod teardown;` to `backend/mod.rs`. Then in `lib.rs` replace the terminal `.run(...)` with:

```rust
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } => backend::teardown::shutdown(app),
            tauri::RunEvent::Exit => backend::teardown::shutdown(app),
            _ => {}
        });
```

`shutdown` is idempotent — it clears the slot — so running on both events is safe.

- [ ] **Step 3: Verify a clean quit leaves no orphan**

```bash
npm run tauri dev -w desktop      # let it reach the reader, then quit with Cmd+Q
ps aux | grep -c "[s]erver.py"
```

Expected: `0`.

- [ ] **Step 4: Verify window-close also tears down**

Relaunch, close the window with the red button rather than Cmd+Q, then re-check.
Expected: `0`.

- [ ] **Step 5: Verify a hard kill still leaves no orphan**

```bash
npm run tauri dev -w desktop &
sleep 45
pkill -9 -f novel-tts-desktop
sleep 5 && ps aux | grep -c "[s]erver.py"
```

Expected: `0` — this is the stdin watchdog (layer 4) doing the work, since SIGKILL runs no Rust code. **If this returns 1, Task 5's watchdog is not wired up.**

- [ ] **Step 6: Verify attach mode does NOT kill the server**

```bash
.venv311/bin/python server.py &
npm run tauri dev -w desktop      # attaches; then quit the app
curl -s http://127.0.0.1:8765/api/engines | head -c 40
```

Expected: the JSON still responds — the app must not have killed a server it did not spawn.

- [ ] **Step 7: Commit**

```bash
git add desktop/src-tauri/src/backend/teardown.rs \
        desktop/src-tauri/src/backend/mod.rs desktop/src-tauri/src/lib.rs
git commit -m "feat: four-layer backend teardown

stdin EOF, then process-group escalation, with the Windows job object and the
server's own stdin watchdog underneath for the cases where no Rust code runs
at all. Attach mode is a deliberate no-op: never kill a server we did not
spawn."
```

---

### Task 14: Single instance and remembered window geometry

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: the builder in `lib.rs`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Add the plugins**

```toml
[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-single-instance = "2"
tauri-plugin-window-state = "2"
```

- [ ] **Step 2: Register them, single-instance first**

At the very top of the builder chain in `lib.rs` — order matters. The duplicate process calls `std::process::exit(0)` and runs no hooks, so registering this first guarantees nothing else has spawned a backend yet:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the existing window instead of starting
            // a rival backend that would race on state.json.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(...)
```

- [ ] **Step 3: Verify single instance**

Launch the app, then launch it again from a second terminal.
Expected: the existing window comes to the front; `ps aux | grep -c "[s]erver.py"` stays at `1`.

- [ ] **Step 4: Verify geometry persistence**

Resize and move the window, quit, relaunch.
Expected: it reopens at the same size and position.

- [ ] **Step 5: Verify the min-width floor holds**

Try to drag the window narrower than ~1024px.
Expected: it stops, and the volume slider, time readout, and realtime figure stay visible.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/src/lib.rs desktop/src-tauri/Cargo.lock
git commit -m "feat: single-instance lock and remembered window geometry

single-instance is registered first: its duplicate process exits without
running hooks, so anything registered earlier could leak a second backend
racing on state.json."
```

---

### Task 15: Native menu and external links

**Files:**
- Create: `desktop/src-tauri/src/menu.rs`
- Modify: `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/capabilities/default.json`, `desktop/src/desktop.ts`, `desktop/src/main.tsx`

**Interfaces:**
- Consumes: `player` from `@/lib/player`; the `restartBackend` command (Task 12).
- Produces: `menu://<id>` events with ids `paste`, `play-pause`, `prev`, `next`, `restart-backend`, `reveal-data`.

- [ ] **Step 1: Add the opener plugin**

```toml
tauri-plugin-opener = "2"
```

```bash
npm install -D @tauri-apps/plugin-opener@2.5.4 -w desktop
```

Add `"opener:allow-open-url"` to the `permissions` array in `capabilities/default.json`.

- [ ] **Step 2: Implement `desktop/src-tauri/src/menu.rs`**

Accelerators are deliberately all modified. `App.tsx:37-59` already handles bare Space and arrows at the document level with a focus-suppression selector; a menu accelerator fires globally regardless of focus and would break typing in the paste textarea and arrow navigation in the voice combobox.

```rust
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

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

    let view = SubmenuBuilder::new(app, "View")
        .fullscreen()
        .minimize()
        .build()?;

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
```

- [ ] **Step 3: Register the menu in `lib.rs`**

```rust
        .plugin(tauri_plugin_opener::init())
        .menu(|app| menu::build(app))
        .on_menu_event(|app, event| menu::handle(app, event.id().0.as_str()))
```

Add `mod menu;`.

- [ ] **Step 4: Subscribe on the JS side**

Append to `desktop/src/desktop.ts`:

```ts
import { openUrl } from "@tauri-apps/plugin-opener"
import { player } from "@/lib/player"

/** Menu commands the Rust side forwards, plus the external-link interception
 *  that `<a target="_blank">` needs — it is inert inside a webview. */
export function installDesktopGlue(onPaste: () => void) {
  void listen("menu://play-pause", () => player.togglePlay())
  void listen("menu://prev", () => player.jump(player.getSnapshot().idx - 1))
  void listen("menu://next", () => player.jump(player.getSnapshot().idx + 1))
  void listen("menu://paste", onPaste)

  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[target='_blank']") as
        | HTMLAnchorElement
        | null
      if (!a?.href) return
      e.preventDefault()
      void openUrl(a.href)
    },
    true,
  )
}
```

- [ ] **Step 5: Install the glue in `main.tsx`**

`App` owns the paste dialog's open state internally, so the menu item dispatches the same keyboard path the UI already handles. Add before `createRoot`:

```tsx
import { installDesktopGlue } from "@desktop/desktop"

installDesktopGlue(() => {
  // App.tsx opens the paste dialog from its own state; the top-bar button is
  // the single entry point, so click it rather than duplicating that state.
  document.querySelector<HTMLButtonElement>("[data-paste-trigger]")?.click()
})
```

Then add `data-paste-trigger` to the Paste button in `frontend/src/components/TopBar.tsx` (the `onClick={onPasteClick}` button). It is inert in the web app.

- [ ] **Step 6: Verify the menu**

Run `npm run tauri dev -w desktop`.
Expected: File / Edit / Playback / View menus present; `Cmd+Shift+R` restarts the backend; `Cmd+N` opens the paste dialog; `Cmd+Space` toggles playback.

- [ ] **Step 7: Verify the accelerators do NOT shadow typing**

Open the paste dialog, type a sentence containing spaces, and press the arrow keys inside the text area.
Expected: spaces are typed (playback does not toggle) and the caret moves normally. Then click an illustration.
Expected: it opens in the system browser, not a dead link.

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/src/menu.rs desktop/src-tauri/src/lib.rs \
        desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock \
        desktop/src-tauri/capabilities/default.json desktop/src/desktop.ts \
        desktop/src/main.tsx frontend/src/components/TopBar.tsx package-lock.json static/
git commit -m "feat: native menu, accelerators and external-link handling

Only modified accelerators are bound: App.tsx already owns bare Space and the
arrows with a focus-suppression selector, and a menu accelerator fires
regardless of focus. The macOS Edit submenu is mandatory or Cmd+C/V do not
work in the paste textarea. <a target=_blank> is inert in a webview, so clicks
are intercepted and opened through the system browser."
```

---

### Task 16: Flush the position on window close

**Files:**
- Modify: `desktop/src-tauri/src/window.rs`, `desktop/src-tauri/src/lib.rs`, `desktop/src/main.tsx`

**Interfaces:**
- Consumes: `player.flushPosition()` (Task 2).
- Produces: `window.__flushPosition` on the JS side; `install_close_flush(&WebviewWindow)` on the Rust side.

- [ ] **Step 1: Expose the flush hook in `desktop/src/main.tsx`**

```tsx
import { player } from "@/lib/player"

declare global {
  interface Window {
    __flushPosition?: () => void
  }
}

window.__flushPosition = () => player.flushPosition()
```

- [ ] **Step 2: Intercept the close in `desktop/src-tauri/src/window.rs`**

```rust
use std::time::Duration;

use tauri::{WebviewWindow, WindowEvent};

/// Give the webview a moment to persist the reading position before the window
/// goes away. WKWebView and WebView2 do not reliably run beforeunload, and
/// savePosition() is a 300ms debounce, so without this a quit mid-chapter can
/// drop the last position write.
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
```

`window.rs` already holds `inject_api_base` from Task 7; this is a second function in the same file, so keep both `use` blocks merged at the top.

- [ ] **Step 3: Call it from `lib.rs` setup**

```rust
            if let Some(main) = app.get_webview_window("main") {
                window::install_close_flush(&main);
            }
```

- [ ] **Step 4: Verify the position survives a close**

Play into the middle of a chapter, note the sentence counter, close the window immediately with Cmd+W, then relaunch.
Expected: it resumes at that sentence, not an earlier one.

- [ ] **Step 5: Verify it does not deadlock the close**

Close the window ten times in a row.
Expected: it closes promptly every time (~150ms), never hangs.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/window.rs desktop/src-tauri/src/lib.rs desktop/src/main.tsx
git commit -m "fix: persist the reading position when the window closes

CloseRequested is intercepted long enough to run flushPosition(), because
webviews do not reliably fire beforeunload and savePosition() is debounced."
```

---

### Task 17: Atomic state writes, docs, and a release build

**Files:**
- Modify: `server.py` (`AppState.save_state`)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-01-desktop-tauri-design.md` (status line)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_server.py`:

```python
def test_save_state_is_atomic(tmp_path):
    """A force-quit mid-write must not truncate state.json: the loader falls
    back to defaults on a corrupt file, silently losing position and voice."""
    worker = FakeWorker(tmp_path / "cache")
    app = create_app(tmp_path, worker, manager=FakeManager())
    client = TestClient(app)
    client.post("/api/state", json={"speed": 1.5})
    # no stray temp files left behind
    assert not list(tmp_path.glob("*.tmp"))
    assert json.loads((tmp_path / "state.json").read_text())["speed"] == 1.5
```

- [ ] **Step 2: Run it**

Run: `.venv/bin/pytest tests/test_server.py::test_save_state_is_atomic -v`
Expected: PASS already for the assertions, but the write is still non-atomic — proceed to make it atomic and keep the test as a regression guard for stray temp files.

- [ ] **Step 3: Make the write atomic**

In `server.py`, replace `AppState.save_state`:

```python
    def save_state(self):
        # temp + replace: a force-quit mid-write would otherwise truncate
        # state.json, and the loader silently falls back to defaults
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.state, indent=2))
        os.replace(tmp, self.state_path)
```

`os` is already imported from Task 5.

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: `200 passed, 1 failed, 2 deselected` — the same single pre-existing `test_romaji` failure.

- [ ] **Step 5: Document the desktop app in `README.md`**

Add after the `## Dev` section:

````markdown
### Desktop app (Tauri, in `desktop/`)

    npm install                    # once, from the repo root
    npm run tauri dev -w desktop   # dev build with live reload
    npm run tauri build -w desktop # bundle a .app / .msi

The desktop app is a shell around the same backend and the same React UI —
`desktop/` compiles `frontend/src`, so a UI change lands in both.

It starts `server.py` itself and shows a startup screen while models load. If a
server is already listening on 8765 (`bash start.sh`) it attaches to that one
instead, so the two never race on `state.json`.

Settings live at `<app config dir>/settings.json`:

| Key | Meaning |
|---|---|
| `mode` | `native` or `wsl` |
| `python` | interpreter to run — must have torch (`.venv311`, not `.venv`) |
| `repo_dir` | checkout holding `server.py` |
| `wsl_distro` / `wsl_repo_dir` / `wsl_python` | WSL2 backend, Windows only |
| `port` | preferred port, default 8765 |
| `hf_home` | override the HuggingFace cache location |
````

- [ ] **Step 6: Mark the spec implemented**

Change the spec's `**Status:** Designed` to `**Status:** Implemented`.

- [ ] **Step 7: Produce a release build**

```bash
npm run tauri build -w desktop
```

Expected: a bundle under `desktop/src-tauri/target/release/bundle/`. Launch it from there — **not** from the dev server — and confirm the reader works, since CSP and asset resolution only take effect in a real build.

- [ ] **Step 8: Verify the web app one final time**

```bash
npm run build -w frontend && .venv311/bin/python server.py
```

Open `http://localhost:8765`, play a chunk, change a voice, set a wallpaper.
Expected: everything behaves exactly as it did before this branch.

- [ ] **Step 9: Commit**

```bash
git add server.py tests/test_server.py README.md \
        docs/superpowers/specs/2026-08-01-desktop-tauri-design.md
git commit -m "feat: atomic state.json writes, desktop docs, spec status

Rounds out the desktop branch: state.json is written temp+replace so a
force-quit cannot truncate it, and the README covers running and configuring
the desktop app."
```

---

## Self-Review

**Spec coverage.** Every section of `2026-08-01-desktop-tauri-design.md` maps to a task: the two blockers → Tasks 1 and 4; shared-frontend refactor → Tasks 1-3; backend changes → Tasks 4, 5, 17; Rust components → Tasks 7-16 (settings 8, discover 9, launch 10, supervise 11, health 12, teardown 13, menu 15, window 7/16); position flush → Tasks 2 and 16; workspace and build → Tasks 6 and 17; decisions table → distributed (min-width in Task 7, macOS floor in Tasks 6-7, interpreter policy in Task 8, no CSP in Task 7); error handling → Task 12; testing → the verification steps throughout.

**Deliberately not implemented**, matching the spec's out-of-scope section: tray, media keys, OS now-playing, auto-update, bundled Python, Linux packaging, and preference migration between the two localStorages.

**Type consistency.** `apiUrl` (Tasks 1, 2, 7), `player.flushPosition` / `window.__flushPosition` (Tasks 2, 16), `DesktopSettings` / `BackendMode` / `resolve_python` (Tasks 8, 10, 12, 15), `Probe` / `probe` / `pick_free_port` / `http_get_json` (Tasks 9, 12), `LaunchSpec` / `build_launch_spec` (Tasks 10, 11, 12), `BackendChild` with `close_stdin` / `try_wait` / `kill_tree` / `log_tail` (Tasks 11, 12, 13), `BackendHandle` / `BackendState.owned` (Tasks 12, 13), `backend://state` and `menu://<id>` (Tasks 12, 15).

**Known soft spots for the implementer to watch.** The `win32job` API in Task 11 and the `SubmenuBuilder` surface in Task 15 are the two places where the exact method names are most likely to need adjustment against the installed crate version; both are self-contained and will surface as compile errors rather than silent misbehavior. Task 11's shell-based tests assume a POSIX shell and should be run on macOS.
