# Desktop App — Tauri 2 shell over the existing backend

**Date:** 2026-08-01
**Status:** Designed
**Extends:** `2026-07-14-novel-tts-design.md`, `2026-07-23-pluggable-tts-engines-design.md`

## Purpose

Ship `novel-tts` as a desktop application with the same features the web app has
today. The TTS engines are PyTorch; Tauri's core is Rust. Reimplementing Kokoro and
Qwen3 in Rust is not viable, so the desktop app is a **shell and process supervisor**,
not a second implementation: it owns a window, a native menu, and the lifecycle of one
`python server.py` child. Synthesis, chunking, caching, and state stay in the existing
backend; the UI stays in the existing `frontend/src`.

Feature parity is therefore achieved by *sharing* rather than *copying*. A new
`desktop/` workspace builds the same React tree the web app builds, so a fix to a
component lands in both apps. Only two shared files change, and the web build's
behavior is unchanged.

## Requirements

- Targets: **macOS native**, **Windows native**, and **Windows shell talking to a
  WSL2 backend**. The backend location is configuration, not a build flag.
- The Python backend is **reused from this repository**, spawned and supervised by
  Tauri. No backend code is duplicated.
- Layout: `desktop/` inside this repo as an npm workspace; Vite aliases `@` into
  `../frontend/src` so the React UI has **one source of truth**.
- Scope: full feature parity plus **basic desktop hygiene only** — remembered window
  geometry, single-instance lock, native app menu, and a startup screen while the
  backend boots. No system tray, no global media keys, no OS now-playing integration.
- Data is **shared** with the web app: the same `novel.txt`, `state.json`, `cache/`,
  `images/`, `voices/`, and `wallpaper`. Close the browser mid-chapter, open the
  desktop app, resume with the cache warm.
- **One backend at a time.** If a server is already listening on the configured port,
  the app attaches to it rather than spawning a rival that would race on `state.json`.
- `start.sh`, `python server.py`, and the web app must behave exactly as they do
  today. Every backend change is additive and defaults to current behavior.

## Architecture

```
┌─ Tauri (Rust) ─────────────────────────────────┐
│  single-instance ▸ window-state ▸ opener       │
│  settings.rs   interpreter, WSL config, port   │
│  backend/  discover ▸ launch ▸ supervise       │
│                     ▸ health ▸ teardown        │
│  menu.rs  window.rs  commands.rs               │
└──────────────────────┬─────────────────────────┘
                       │ spawns, supervises, kills
                       ▼
        python -u server.py --host 127.0.0.1 --port <p>
                            --data-dir <repo> --exit-on-stdin-close
                       ▲
                       │ HTTP, base = window.__API_BASE__
┌──────────────────────┴─────────────────────────┐
│  WebView (tauri://localhost)                   │
│    desktop/src/main.tsx                        │
│      <Boot/> until ready, then <App/>          │
│      imports @/App, @/components/*, @/lib/*    │
│      ─────────▶ ../frontend/src (shared)       │
└────────────────────────────────────────────────┘
```

The webview loads the desktop's own Vite bundle from `tauri://localhost`, **not** from
the Python origin. This is deliberate: in attach mode the already-running server may be
serving a stale `static/` build that does not contain the desktop entry point. The
consequence is that the two blockers below are both mandatory.

## The two blockers

Thirteen risks were catalogued during design; six were put through adversarial
verification and two survived. Those two are blockers — without either fix the desktop
app does not function at all.

### B1 — Origin-relative URLs never reach FastAPI

Every server URL in the shared tree is root-relative: `api.ts:70,78,79,81,83,86,88,98,104`
and `wallpaper.ts:11,18,33,44`. Under Tauri the origin is `tauri://localhost`
(`http://tauri.localhost` on Windows), and Tauri's asset resolver has an SPA fallback
chain ending at `index.html`.

The failure is quiet rather than loud. `fetch("/api/doc")` returns **HTTP 200 with
`Content-Type: text/html`**, so `resp.ok` is true, `api()`'s error branch at `api.ts:71`
is skipped, and `resp.json()` throws a parse error. Expect `Unexpected token '<'`, not
404s. `useWallpaper` swallows it at `wallpaper.ts:23`, so the wallpaper silently never
appears; `<img>` and `<audio>` receive HTML and surface as decode errors.

### B2 — No CORS middleware

`server.py:222` constructs a bare `FastAPI(lifespan=lifespan)`. There is no
`CORSMiddleware` in `server.py`, `webpage.py`, or `mcp_app.py`. Once B1 is fixed the
calls become genuinely cross-origin.

Two failure classes, and the second is the dangerous one:

- **Preflighted requests** simply fail. Every `api(path, body)` call sets
  `Content-Type: application/json` (`api.ts:66-67`); `POST /api/image` (`api.ts:98`) and
  `POST /api/wallpaper` (`wallpaper.ts:33`) send a `File` whose `image/*` type is
  non-safelisted; `deleteClone` (`api.ts:83`) and `removeWallpaper` (`wallpaper.ts:44`)
  use DELETE.
- **Simple requests that mutate state and then discard the response.**
  `POST /api/voices/clone` (`api.ts:80-81`) sends a bare `ArrayBuffer` and therefore sets
  no `Content-Type`. It reaches the handler and **writes the clone to disk** while the JS
  promise rejects and the UI reports failure. That divergence is why this is a blocker
  rather than a nuisance.

## Shared-frontend refactor

The goal is exactly **one** place where the API origin is injected. Two files change,
eight call sites. No component, hook, or other lib file is touched.

### `frontend/src/lib/api.ts`

Add above `api()`:

```ts
declare global { interface Window { __API_BASE__?: string } }

/** Origin of the Python server. "" = same-origin (web app + vite dev proxy).
 *  The desktop shell sets window.__API_BASE__ before the app mounts.
 *  INVARIANT: no trailing slash and no query string — player.ts compares
 *  `audio.src.endsWith(audioUrl(cid))`, which only holds while the base is a
 *  bare origin. */
const base = () =>
  (typeof window !== "undefined" ? window.__API_BASE__ : undefined) ??
  (import.meta.env.VITE_API_BASE as string | undefined) ?? ""

export const apiUrl = (path: string) => base() + path
```

`base()` is read at **call time**, not module-eval time. That removes every ordering
hazard between the Rust injection and module evaluation.

| Line | Change |
|---|---|
| `api.ts:70` | `fetch(path, init)` → `fetch(apiUrl(path), init)` |
| `api.ts:86` | `` `/api/audio/${cid}` `` → ``apiUrl(`/api/audio/${cid}`)`` |
| `api.ts:88` | `` `/api/image/${iid}` `` → ``apiUrl(`/api/image/${iid}`)`` |
| `api.ts:98` | `fetch("/api/image", …)` → `fetch(apiUrl("/api/image"), …)` |

The single edit at `:70` covers `getEngines`, `getVoices`, `uploadClone`, `deleteClone`,
`importImageUrl`, and every `api()` call in `player.ts`.

### `frontend/src/lib/wallpaper.ts`

Add `import { apiUrl } from "./api"`, then wrap the four URLs at `:11`, `:18`, `:33`,
`:44`.

### Consumers verified as needing no change

`player.ts` `audio.src` and prefetch; the two `endsWith(audioUrl(cid))` comparisons;
`Reader.tsx:109` `<a href>` and `:111` `<img src>`; `App.tsx:76` CSS `url()`.

The `endsWith` tests stay correct in **both** modes. With base `""` the element
absolutizes `/api/audio/x` to `<origin>/api/audio/x`, which ends with `/api/audio/x`.
With base `http://127.0.0.1:8765` both sides are the identical absolute string. The
invariant comment above is what protects this.

### Web app regression surface: zero

`window.__API_BASE__` is undefined and `VITE_API_BASE` unset in the web build, so
`apiUrl()` returns the identical strings it returns today, and the Vite dev proxy at
`frontend/vite.config.ts:15-17` keeps working unchanged.

### The pre-paint theme bootstrap

`frontend/index.html:9-25` is a hand-written IIFE with its own hardcoded copies of the
accent and scheme lists — already a three-way duplication with `theme.ts:4-15` and
`index.css:174-604`. A desktop `index.html` would make it four. Move it once to
`frontend/public/theme-boot.js` (the `public/` directory does not exist yet and must be
created); both HTML files load it as a **classic** script (a module script is deferred
and would flash). `desktop/vite.config.ts` points `publicDir` at `../frontend/public`.

Carry these into the desktop HTML verbatim: `<html lang="en" class="dark">`, the
`<meta name="theme-color" content="#131316">` that `theme.ts:132-134` writes to,
`index.css`'s dependence on `.dark`, and the inline SVG book-emoji favicon
(`frontend/index.html:5`) so the app icon in the tab-less webview matches.

### Everything else in `frontend/src` is portable unchanged

`localStorage` (`theme.ts`, `reading.ts`), `window.matchMedia`, `DOMParser`
(`paste.ts:22`), `DOMMatrixReadOnly` (`follow.ts:46`), `window.setTimeout`
(`Clock.tsx`), and the bundled `@fontsource` imports all work in both WebViews.
`document.startViewTransition` (`theme.ts:163`) is already feature-detected with an
instant fallback. There is no `process`, no `require`, no Node built-in, no service
worker, and no History API use anywhere in the tree.

## Backend changes

Three additions to `server.py`. Nothing is removed, and every default preserves current
behavior.

### CORS

`create_app` gains `cors_origins: list[str] | None = None`. Immediately after
`server.py:222`:

```python
DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost",
                   "https://tauri.localhost"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[*DESKTOP_ORIGINS, *(cors_origins or [])],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"], allow_headers=["*"], max_age=600)
```

Each part is load-bearing:

- Starlette matches `allow_origins` by **exact string**, so `tauri://localhost` must be
  listed literally. A wildcard-scheme pattern will not match it.
- `allow_methods=["*"]` is what installs the OPTIONS preflight responder. FastAPI has no
  OPTIONS route for these paths and would answer 405 to the two DELETEs.
- `allow_origin_regex` covers the desktop dev server on `http://localhost:1420`, so
  `tauri dev` works without a second config knob.
- `"null"` is deliberately **not** listed. An earlier draft of this spec included it
  as "cheap insurance" against opaque origins; that was wrong. `Origin: null` is
  forgeable from any sandboxed iframe or `data:` URI, so allow-listing it would let
  any page the user visits reach these routes — including `DELETE /api/wallpaper` and
  `POST /api/voices/clone` — and read the responses. A Tauri webview never sends it.
- **Do not** set `allow_credentials=True`. Nothing in the client sends cookies.

Element loads — `audio.src`, `<img src>`, CSS `url()` — are no-cors and work with or
without this. The prefetch in `player.ts` is a cors-mode `fetch` and does need it.

### Sidecar contract on `main()`

```python
def main(argv=None):
    ap = argparse.ArgumentParser(prog="novel-tts")
    ap.add_argument("--host", default=os.environ.get("NOVEL_TTS_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("NOVEL_TTS_PORT", "8765")))
    ap.add_argument("--data-dir", default=os.environ.get("NOVEL_TTS_DATA_DIR"))
    ap.add_argument("--cors-origin", action="append", default=[])
    ap.add_argument("--exit-on-stdin-close", action="store_true")
    args = ap.parse_args(argv)
    ...
    root = Path(args.data_dir).expanduser().resolve() if args.data_dir else Path(__file__).parent
```

`root` feeds **four** consumers that are not derived from each other inside
`create_app`: the `state.json` peek, `EngineManager` (which constructs
`CloneStore(data_dir/"voices")` at `tts/manager.py:15`), `TTSWorker(root/"cache")`, and
`create_app(root, …)` (which owns `novel.txt`, `state.json`, `images/`, `wallpaper`). A
single `root` variable is what keeps all of them in one directory. Do not thread a
separate cache path.

**Do not use `--port 0`.** `uvicorn.run` gives no way to read back the bound port, so the
ephemeral-port trick is unusable here. Port selection stays in Rust.

### stdin-EOF watchdog

```python
def _watch_stdin():
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

Tauri always pipes stdin to the child, and the pipe closes when the shell process dies
for any reason. This is the **only** teardown mechanism that reaches a Python process
running inside WSL2, where a Windows job object has no jurisdiction. Gated behind the
flag so `start.sh` is unaffected.

### What deliberately does not change

- **`STATIC_DIR`.** The desktop serves its own bundle and never GETs `/`; the `/assets`
  mount is already guarded by `assets_dir.exists()`.
- **No `/health` endpoint.** `GET /api/engines` is already the right probe — see below.
- **`audio_wait=30.0`.** The client's own 5×2s retry ladder already handles it.
- **The `"novel-tts ready"` log line.** It stays, but the supervisor must never scrape
  it: it fires one line *before* `uvicorn.run` binds, and `log_level="warning"`
  suppresses uvicorn's own bind banner.

### Optional hardening

`AppState.save_state` rewrites `state.json` whole with no atomic rename. A force-quit
mid-write truncates it, and the loader tolerates that by falling back to defaults —
silently losing position, voice, and speed. Two lines: temp-file plus `os.replace`.

## Rust components

```
desktop/src-tauri/src/
  main.rs              thin: desktop_lib::run()
  lib.rs               builder assembly, plugin order, RunEvent ladder
  settings.rs          DesktopSettings serde struct, atomic JSON in app_config_dir()
  backend/discover.rs  probe / attach / port selection
  backend/launch.rs    argv construction (native + WSL), env, OS spawn flags
  backend/supervise.rs child handle, stdout/stderr readers, log ring buffer
  backend/health.rs    readiness poll, state machine, event emission
  backend/teardown.rs  the kill ladder
  menu.rs              native menu + accelerators
  window.rs            window creation, base-URL injection, close interception
  commands.rs          #[tauri::command] surface
```

### Plugin registration order

`tauri-plugin-single-instance` **must be first**. Its duplicate process calls
`std::process::exit(0)` and runs no hooks, so registering it first guarantees nothing
else has spawned a backend yet. Then `tauri-plugin-window-state`, then
`tauri-plugin-opener`, then managed state.

### Settings

`DesktopSettings` is a typed serde struct at `app_config_dir()/settings.json`, written
temp-plus-rename: `mode` (Native | Wsl), `repo_dir`, `python`, `wsl_distro`,
`wsl_repo_dir`, `wsl_python`, `port`, `extra_args`, `hf_home`.

Hand-rolled serde rather than `tauri-plugin-store`, because these fields are the direct
inputs to a process spawn — they must be a validated Rust struct the webview cannot
rewrite key-by-key. Reading and writing from Rust needs no capability entry at all; the
ACL only gates IPC from the webview.

### Readiness probe

`GET /api/engines`. It calls `engine_catalog()` (pure `importlib.util.find_spec`,
`tts/registry.py:24-30`) and `manager.engine_id` (a lock-free property,
`tts/manager.py:20-22`). It takes neither `st.lock` nor the manager `RLock`, so it cannot
block behind an in-flight synthesize.

Explicitly **not**: `GET /api/doc` and `GET /api/voices` both take `st.lock`, which
`POST /api/state` holds across `manager.swap` / `set_mode` / `set_instruct`.
`GET /api/audio/{cid}` blocks for `audio_wait` = 30s.

Poll every 300ms with a **300s deadline** — a cold path can include a torch import
(5–15s), a 313 MB Kokoro download, or a ~1.8 GB Qwen3 variant. Surface elapsed time and
the live stderr tail rather than a spinner.

Warmth is a separate, optional signal. Use `engine.speed > 0 || status.ready.length > 0`,
**not** `engine.cold`: `TTSEngine.info()` returns a flat `"cold": False`
(`tts/base.py:76-78`) that `KokoroEngine` never overrides — only Qwen3 does
(`tts/qwen.py:68-69`). Simpler still: dismiss the startup screen at HTTP-ready and let
the existing in-app status line own warmth.

### Port discovery and attach

1. `settings.port`, default 8765.
2. `probe(port)`:
   - **Free** (`ConnectionRefused` within 250ms) → spawn on `port`.
   - **NovelTts** → attach. `base = http://127.0.0.1:<port>`, `child = None`, teardown
     skips L1–L3, and the startup screen says so.
   - **Foreign** → pick a free ephemeral port and spawn there. Never attach, never
     clobber.
3. Shape-checking is mandatory before attaching: HTTP 200 plus a JSON body with an
   `engines` array whose entries carry `id`/`supported_modes`, plus a `current` string.
   Attaching to whatever happens to hold 8765 would point the reader at an unrelated
   process.
4. `pick_free_port()` binds `127.0.0.1:0`, reads `local_addr().port()`, drops. Accept the
   TOCTOU window; retry the whole spawn up to 3 times on bind failure.

### Process supervision

`std::process::Command`, **not** `tauri-plugin-shell`. The shell plugin's `Command`
exposes no OS spawn controls — no process group, no job object, no creation flags — and
its `RunEvent::Exit` cleanup only kills children registered through the JS
`plugin:shell|spawn` IPC path. A Rust-side child is neither tracked nor killed.

- **unix:** `cmd.process_group(0)`, so pgid == child pid and the whole tree is killable.
- **windows:** `creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)`, then create a Job
  with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign the child, resume the main thread.
  The Job handle lives in managed state for the app's lifetime.

Two reader threads split stdout and stderr into lines feeding a bounded 2000-line ring
buffer (so a reloaded webview can backfill) and a `tauri::ipc::Channel<LogLine>`.
Channels rather than events, for throughput and ordering.

Launch argv:

```
native: <python> -u server.py --host 127.0.0.1 --port <p> --data-dir <repo>
                 --exit-on-stdin-close [--cors-origin http://localhost:1420 in dev]
wsl:    wsl.exe -d <distro> --cd <wsl_repo_dir> --exec <wsl_python> -u server.py
                 --host <bind> --port <p> --data-dir <wsl_repo_dir> --exit-on-stdin-close
```

`--exec` avoids a shell layer. `<bind>` is `127.0.0.1` under WSL mirrored networking
(Win11 22H2+), else `0.0.0.0` with NAT localhost-forwarding. **Never invoke `start.sh`**
— see the interpreter decision below.

### Teardown ladder

| Layer | Mechanism | Survives |
|---|---|---|
| L1 | `ExitRequested` → flush position, close child stdin, wait ≤3s | clean quit |
| L2 | `killpg` SIGTERM → 2s → SIGKILL (unix) / `TerminateJobObject` (win) | unclean quit |
| L3 | Windows job object, `KILL_ON_JOB_CLOSE` | Rust panic, Task Manager |
| L4 | Python stdin-EOF watchdog | everything, including WSL |

Plus `panic = "unwind"` in `[profile.release]`, deviating from the create-tauri-app
default of `"abort"`, so `RunEvent::Exit` still runs on a panic.

**Attach mode skips L1–L3 entirely.** Never kill a server this app did not spawn.

If the child exits unexpectedly, emit `backend://exited` and re-show the startup screen
with the stderr tail and a Retry button. **Do not auto-respawn in a loop** — an
`ImportError` would spin forever. At most one automatic retry after 2s.

### Native menu

`tauri::menu::*`, with `.enable_macos_default_menu(false)` once a custom menu is supplied.

- **App menu (macOS, must be first):** About · Settings… (`CmdOrCtrl+,`) · Services ·
  Hide/Hide Others/Show All · Quit (already carries `Cmd+Q`; do not re-bind).
- **File:** Paste chapter… (`CmdOrCtrl+N` — **not** `CmdOrCtrl+V`, which collides with
  the textarea) · Restart backend (`CmdOrCtrl+Shift+R`) · Reveal data folder · Close Window.
- **Edit:** Undo/Redo/Cut/Copy/Paste/Select All as `PredefinedMenuItem`. **Required on
  macOS** — without it `Cmd+C`/`Cmd+V` do not work in the paste textarea at all.
- **View:** Full Screen · Minimize · Zoom.
- **Playback:** Play/Pause · Previous Sentence · Next Sentence.

Menu events are matched on `event.id().0.as_str()` and forwarded to JS via
`Emitter::emit("menu://<id>")`; `desktop.ts` maps them onto `player.togglePlay()` and
`player.jump(±1)`.

**Only modified accelerators.** `App.tsx:37-59` already handles bare Space and arrows at
the document level with a focus-suppression selector. A menu accelerator fires globally
regardless of focus and would break typing in the paste textarea and arrow navigation in
the voice combobox.

### Window and startup screen

`window.rs` creates the main window after settings load but **without** waiting for the
backend — the startup screen lives inside the same React app, so there is only one
window. A second window would fight `tauri-plugin-window-state`.

Base URL injection: `webview.eval("window.__API_BASE__=…")` as soon as it is known.
Because `apiUrl()` reads the global at call time, late injection is safe.

`desktop/src/Boot.tsx` listens to `backend://state` and renders Discovering / Spawning /
Waiting (elapsed seconds plus the last 20 stderr lines, collapsible) / Attached /
Failed (stderr tail, Retry, Open settings). Past 20 seconds it must say "this can take
several minutes on first run — downloading model weights."

### Desktop entry point

`desktop/src/main.tsx` imports `@/index.css` and `@/App`, renders `<Boot/>` until
`backend://state` reaches Ready or Attached, then `<App/>`. Gating on Boot also
guarantees `player.start()` (`App.tsx:27-29`) never fires before the base URL exists.

It additionally installs a capture-phase click listener that intercepts
`<a target="_blank">` (`Reader.tsx:109`, inert in a webview) and routes it through
`openUrl()`, sets `window.__flushPosition`, and subscribes to `menu://*`.

`App.tsx` and every file under `frontend/src/components` and `frontend/src/lib` stay
byte-identical between the two apps apart from the two URL edits and the position flush.

## Position flush on close

`savePosition()` (`player.ts:388-393`) clears and re-arms a single 300ms timer and has no
flush path, and the file registers no `pagehide` or `visibilitychange` handler. Window
destruction in WKWebView and WebView2 does not reliably run `beforeunload`, so **quitting
mid-chapter can lose your place.**

Add a public `flushPosition()` to `PlayerEngine` that clears the timer and POSTs
immediately with `keepalive: true`. In `window.rs`, intercept `WindowEvent::CloseRequested`,
`api.prevent_close()`, eval `window.__flushPosition?.()`, then close after ~150ms. Same on
`RunEvent::ExitRequested`.

This is the only shared-code addition beyond the URL injection, and it benefits the web
app too.

## Workspace and build

New root `package.json`: `{ "private": true, "workspaces": ["frontend", "desktop"] }`.
There is no root `package.json` today.

`desktop/package.json` must declare every runtime dependency `frontend/src` imports —
react, react-dom, motion, sonner, cmdk, radix-ui, lucide-react, class-variance-authority,
clsx, tailwind-merge, tailwindcss, @tailwindcss/vite, tw-animate-css, and all 17
`@fontsource*` packages. npm hoisting usually satisfies these from the root
`node_modules`, but declare them explicitly: `index.css:1-43` resolves
`@fontsource-variable/*` through Vite's CSS `@import`, which fails hard if hoisting
misses.

`desktop/vite.config.ts`:

| Key | Value |
|---|---|
| `resolve.alias["@"]` | `../frontend/src` |
| `publicDir` | `../frontend/public` |
| `build.outDir` | `dist` — **never** `../static`; `frontend/vite.config.ts:19-22` builds there with `emptyOutDir: true` |
| `server.port` | 1420, `strictPort: true` (must equal `tauri.conf.json` `devUrl`) |
| `build.target` | `chrome105` on Windows, `safari16` on macOS — **not** the template's `safari13`; `index.css` needs `oklch()`/`color-mix()` |
| `envPrefix` | `["VITE_", "TAURI_ENV_*"]` |

**Tailwind's scanner does not follow the `@` alias across the workspace boundary.** The
alias resolves JS/TS imports; it has no CSS-scanning equivalent, so the desktop build
emits almost no utility classes (measured: 8 selectors versus the web build's 311) and
the app renders unstyled. The desktop workspace therefore needs its own CSS entry that
re-exports the shared stylesheet and adds an explicit source directive:

```css
/* desktop/src/index.css */
@import "../../frontend/src/index.css";
@source "../../frontend/src";
```

`@source` paths resolve relative to the CSS file containing them. Verify by comparing the
built desktop CSS against `static/assets/*.css` — selector count, rule count and byte size
should be in the same ballpark. An earlier draft of this spec claimed the following, which
is wrong and was disproved during implementation:

> ~~Tailwind v4 discovers classes through the module graph, so importing `@/index.css` and
> the shared components from `desktop/src/main.tsx` is sufficient; no `content` globs
> needed. If a class ever goes missing, add `@source "../../frontend/src";`.~~

`desktop/package.json` must also declare **`shadcn`** — `frontend/src/index.css` does
`@import "shadcn/tailwind.css";`, so omitting it leaves the build depending on npm
hoisting luck. And `frontend/package-lock.json` must be **deleted** once `frontend` is a
workspace member: the root lockfile is authoritative, and a stale nested one invites a
`cd frontend && npm ci` that installs a diverging dependency set.

### Dependencies

Rust — pin the major; resolved versions as of 2026-08-01 in brackets:

```
tauri 2 [2.11.5] · tauri-build 2 [2.6.3] · serde 1 + derive · serde_json 1
tauri-plugin-single-instance 2 [2.4.3]   (Rust only, no npm package)
tauri-plugin-window-state 2 [2.4.1]
tauri-plugin-opener 2 [2.5.4]
unix: libc 0.2        windows: win32job 2 [2.0.3]
```

MSRV 1.77.2. Not used: `tauri-plugin-shell`.

npm: `@tauri-apps/cli` 2.11.4, `@tauri-apps/api` 2.11.1,
`@tauri-apps/plugin-window-state` 2.4.1, `@tauri-apps/plugin-opener` 2.5.4.

`capabilities/default.json`: `core:default` plus `opener:allow-open-url` scoped to
http/https. **No `shell:` permissions** — the webview never spawns anything.

### CSP

`app.security.csp` defaults to null and Tauri injects no policy. Verified: none is
needed, and setting one can only break things. If one is ever added it must include
`connect-src data:` (for the clipboard data-URI fetch at `PasteDialog.tsx:31-33`),
`font-src data:` (Vite inlines two JetBrains Mono woff2 faces under the default
4096-byte `assetsInlineLimit`), and `style-src 'unsafe-inline'` (sonner's runtime
`__insertCSS()` and react-style-singleton's scroll-lock sheet). Note that CSP is not
applied at all under `devUrl`, so a mistake first appears in `tauri build`.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Which Python? | Configured path in `settings.json`, auto-detecting `.venv311` then `.venv`. No pip bootstrap. Invalid path fails into the startup screen with a "select interpreter" action. | `start.sh:6` creates `.venv` with bare `python3`; on this machine that is 3.14 and `import torch` raises `ModuleNotFoundError`, while the working env is the untracked `.venv311` (3.11, torch present). Both exist in the tree today, and `start.sh` would pick the broken one. Validation must therefore probe the interpreter, not just the path. pip gives no machine-readable progress for a 1 GB install. |
| macOS floor | `minimumSystemVersion: "13.3"`, Vite `target: safari16`. | `watermark.ts:61` uses regex lookbehind with **no fallback** — a SyntaxError at module parse would take the whole bundle down. That is WebKit 16.4. `oklch()`/`color-mix(in oklab)` need 16.2+. |
| Window min width | `minWidth: 1024`, above the Tailwind `lg` breakpoint. | Six controls hide at `sm`/`md`/`lg`. Pinning above `lg` keeps the volume slider, time column, and realtime readout always visible. |
| Theme prefs | No migration. | `tauri://localhost` has its own `localStorage`, so `novel-tts:theme` and `novel-tts:reading` do not carry over. Re-picking a theme takes 20 seconds; an import handshake does not earn its complexity. |
| Signing | Unsigned local install. | Personal app. Revisit if it is ever distributed. |
| HF model cache | Left at `~/.cache/huggingface`. | Shared with the web app; relocating would re-download gigabytes. |
| MCP connector | Untouched; rides along on the sidecar. | Import-guarded already. Its "mcp package not installed" warning will appear in the sidecar's stderr when absent, which is harmless. |
| Data dir when the repo is absent | Hard error into the setup screen. | This is a dev-machine app pointed at a checkout. A silent fallback to `app_data_dir()` would create a second, divergent library. |
| Backend network exposure | Prefer WSL mirrored networking so `127.0.0.1` still works; fall back to `--host 0.0.0.0` only under NAT. No auth token. | There is no auth on any endpoint and `POST /api/image/fetch` has no SSRF guard; today the only containment is the `127.0.0.1` bind. A token would force a custom header and therefore a preflight on every request. |
| macOS lifecycle | Default quit-on-last-window-close. | No tray is in scope, so surviving window close would leave an invisible app. |

## Error handling

- **Backend fails to start** → startup screen with the stderr tail, a Retry button, and a
  link to settings. At most one automatic retry.
- **Backend dies while running** → `backend://exited`, startup screen returns, playback
  stops. No respawn loop.
- **Foreign process on the port** → spawn on an ephemeral port instead; never attach,
  never kill.
- **Attached server quits under us** → same as backend-died, but Retry re-runs discovery
  rather than assuming ownership.
- **Interpreter path invalid** → validated before spawn, so the failure is "choose an
  interpreter" rather than a Python `ImportError` traceback.
- In-app errors (voice change failed, wallpaper upload failed, chapter load failed) keep
  flowing through the existing sonner toasts unchanged.

## Testing

- **Python:** extend the existing fast suite. `main()` argument parsing (host/port/
  data-dir/cors-origin defaults preserve today's values); `create_app(cors_origins=…)`
  emits the right `Access-Control-Allow-Origin` for `tauri://localhost` and answers
  OPTIONS on the two DELETE routes; `--data-dir` puts `cache/`, `voices/`, `images/`,
  `novel.txt`, `state.json`, and `wallpaper` in one directory; the stdin watchdog is not
  installed without the flag.
- **Frontend:** `apiUrl()` returns unchanged strings when no base is set, and the
  `endsWith(audioUrl(cid))` invariant holds under both bases. The web build must be
  verified byte-equivalent in behavior — `npm run build` in `frontend/` still emits a
  working `static/`.
- **Rust:** unit-test `probe()` classification (Free / NovelTts / Foreign) against a stub
  HTTP server, and `pick_free_port()`.
- **Manual, per platform:** the teardown ladder is the thing most likely to be wrong.
  Verify no orphaned Python after normal quit, window close, Force Quit / Task Manager,
  and a Rust panic — on macOS native, Windows native, and Windows→WSL2.
- **Manual, unverified risk:** `navigator.clipboard.read()` for image paste
  (`PasteDialog.tsx:152`) behaves differently in WKWebView and WebView2. The existing
  three-tier fallback already degrades to "press Ctrl+V in the text area instead", and
  the native `onPaste` handler is unaffected because it reads `clipboardData`. If
  `read()` fails on either platform, wire that one button to
  `@tauri-apps/plugin-clipboard-manager` in `desktop.ts` only — do not change
  `PasteDialog.tsx`.

## Out of scope (deliberately)

- System tray, global media keys, OS now-playing integration (macOS Now Playing,
  Windows SMTC), desktop notifications.
- Auto-update.
- Bundling Python or the model weights into the installer.
- Rewriting any TTS engine in Rust.
- A Linux build. Nothing in the design precludes it — the unix teardown path already
  covers it — but it is not a target and will not be tested.
- Porting the reading/theme preferences to the server so they follow the user between
  the web and desktop apps.

## Risks catalogued but not verified

Six of thirteen candidate risks were adversarially verified; two survived as the blockers
above, and four were refuted — notably that macOS suspends the webview when minimized
(false for audio-playing pages: WebKit takes a foreground audio assertion and Blink's
throttling checks `IsAudioPlaying()`), and that a CSP is required (Tauri injects none by
default).

The remaining seven were catalogued from source reading but **not** put through
verification, so treat them as lower-confidence: `target="_blank"` being inert,
clipboard permission behavior, auto-scroll requiring the document to be the scroller,
the accelerator collision, backend network exposure under WSL NAT, non-atomic
`state.json` writes, and the `static/` build-output collision. Each has a mitigation in
the sections above.

## Coordination note

**Line numbers in this spec are as of `a370a19`**, which is both `master` and the parent
of this branch, so they are accurate as written.

An MCP connector was built on `feat/mcp-translate-connector` on 2026-08-01 between 03:04
and 03:19 (`1dc22b8`..`a370a19`) and fast-forward merged into `master` at 13:28 the same
day. It adds `webpage.py`, `mcp_app.py`, `mcp_tools.py`, and mounts `/mcp` in `server.py`.
It also modified `frontend/src/lib/player.ts` — notably the 2s status poll now preserves
the currently-playing chunk by cid across a `doc_id` change instead of always pausing, so
any description of that poll as "always pauses on doc change" is stale.

That work is merged, so there is no longer a conflict to sequence around. Both
`server.py` and `player.ts` are nonetheless files this design modifies: re-read
`server.py`, `api.ts`, and `player.ts` immediately before editing each one rather than
trusting the line numbers above, in case further work lands first.
