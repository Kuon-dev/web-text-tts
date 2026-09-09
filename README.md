# novel-tts

Local audiobook player for pasted light-novel text. Kokoro-82M / Qwen3-TTS, browser player.

## Use

    bash start.sh          # then open http://localhost:8765 in your Windows browser

Paste a chapter (button top right, or edit `novel.txt`), press Play.

- Space = play/pause · ←/→ = skip chunk · click any sentence to jump
- Bottom player bar: searchable voice combobox (grouped by engine/language),
  transport, volume + mute, speed popover (with pause-between-sentences slider), clickable chapter-progress strip
- Engine picker (settings): **Kokoro-82M** (default, 16 voices; falls back to CPU
  under GPU contention) or **Qwen3-TTS 1.7B** (9 preset speakers incl. native
  Japanese, GPU-only; pauses generation when GPU is busy — playback waits, UI
  explains why). Switching engine regenerates cached audio; per-engine voice memory.
- Aa menu (top right): theme (light / dark / system) + accent color, reading font
  (Georgia / Literata / Inter / System), size, line & paragraph spacing, text
  width, justify, auto-scroll — saved in the browser
- Position (per chapter), voice, speed, volume, and sentence pause are saved — close anything, it resumes.
- Audio cache: `cache/` (2 GiB cap, auto-evicted). Switching engine, changing style
  instruction, or replacing a clone's reference clip regenerates that voice's
  cached audio. State: `state.json`.
- Pasting a chapter keeps its illustrations — HTML `<img>` and markdown
  `![alt](src)` alike are downloaded into `images/` and become `[img:<sha1>]`
  lines — and filters anti-theft watermark sentences, with an undo on the toast.

### Private image hosts

If illustrations sit behind a bearer token, put it in `.env` next to `start.sh`
(git-ignored, and excluded from deploys so an rsync can't clobber it):

    NOVEL_TTS_IMAGE_TOKEN=<token>
    NOVEL_TTS_IMAGE_TOKEN_HOSTS=localhost:8787,127.0.0.1:8787

The token goes only to the `host:port` values listed there. That allowlist is the
point: the rest of a chapter's images come from untrusted sites, and a token
offered to one of those is a token given away.

## Qwen3-TTS extras

First use downloads ~4.3 GB per model variant (CustomVoice for preset voices, Base
for cloning).

- **Style instruction** (settings, Qwen3 only): "read calmly…" etc. Applies to
  preset voices; regenerates audio if changed. The 1.7B model honours it
  (the 0.6B it replaced did not); "Calm, even narration. Neutral tone, no
  laughing or sighing." is the one that removed the stray sighs and laughs.
- **Runaway guard** (Qwen3 only): the model can miss its stop token on
  breathy lines and huff for a minute (the old 0.6B did so often, the 1.7B rarely). Every generation is capped at
  1.6× the expected narration length + 2s; anything that hits the cap is
  regenerated once and cut there. Look for `runaway:` in the server log.
- **Voice cloning** (settings, 3–30s audio clip): Upload a reference clip in
  settings; the cloned voice appears in the combobox under "Cloned".

## MCP connector (translate a website into the reader)

With the server running, an AI agent can fetch a page, translate it, and load the
translation for the TTS to read:

    claude mcp add --transport http novel-tts http://localhost:8765/mcp

Tools: `fetch_page(url)` (the page's chapter text — nav/ads/footers stripped,
illustrations imported as `[img:…]` markers), `load_text(text)` (replaces the
document), `append_text(text)` (adds the next page, keeping your place *and*
playback), `get_status()` (position, engine, voice, what has audio yet).

The agent does the translating — no API key, and the server sends nothing anywhere
except the page fetch itself. A load lands in the open browser within a couple of
seconds. If `mcp` isn't installed the reader still runs, just without `/mcp`.

## Remote GPU deployment (Tokyo L4 box)

A second checkout runs on `ai-tokyo-g6-xlarge` (SSH alias, `~/.ssh/config`;
EC2 `i-022412f4ce64ccf2f`, AI-GPU-Dev, ap-northeast-1, NVIDIA L4) at
`/var/tmp/web-text-tts`, for GPU access instead of the local Mac. It's a
manual deployment — not a git checkout, no systemd unit, no nginx proxy
(nginx on that box only fronts an unrelated app on :8000) — so it doesn't
survive a reboot and won't be found by grepping for "tts" in any repo/doc,
only by listing `/var/tmp` on the box itself.

Start it (detached tmux session so it survives SSH disconnect):

    ssh ai-tokyo-g6-xlarge "tmux new-session -d -s novel-tts -c /var/tmp/web-text-tts './start.sh 2>&1 | tee -a start-console.log'"

It listens on `127.0.0.1:8765` (same default port as local). Reach it from
the Mac via an SSH tunnel:

    ssh -f -N -L 8765:127.0.0.1:8765 ai-tokyo-g6-xlarge

then open `http://localhost:8765`. Check it's up / reattach to logs:

    ssh ai-tokyo-g6-xlarge "ss -tlnp | grep 8765"   # confirms it's listening
    ssh ai-tokyo-g6-xlarge -t "tmux attach -t novel-tts"

`sox` isn't installed on that box — harmless warning, not a hard dependency.

## Dev

    .venv/bin/pytest -m "not slow"    # fast suite (runs without torch/qwen-tts)
    .venv/bin/pytest -m slow          # real-model smoke test

Engines live in the `tts/` package (base contract, DevicePolicy, registry,
manager). Fast suite runs all unit tests without requiring torch or qwen-tts;
real-model tests are marked `-m slow`.

### UI (React + Vite + shadcn/ui, in `frontend/`)

    export PATH=~/node22/bin:$PATH
    npm install                  # once, from the repo root (npm workspace: frontend + desktop)
    npm run build -w frontend    # emits the served app into ../static
    npm run dev -w frontend      # live-reload dev server on :5173, proxies /api to :8765

The server serves the prebuilt `static/` — Node is only needed to change the UI.

### Desktop app (Tauri, in `desktop/`)

    npm install                    # once, from the repo root
    npm run tauri dev -w desktop   # dev build with live reload
    npm run tauri build -w desktop # bundle a .app / .msi

The desktop app is a shell around the same backend and the same React UI —
`desktop/` compiles `frontend/src`, so a UI change lands in both.

It starts `server.py` itself and shows a startup screen while models load. If a
server is already listening on 8765 (`.venv311/bin/python server.py`) it
attaches to that one instead, so the two never race on `state.json`.

Settings live at `<app config dir>/settings.json`:

| Key | Meaning |
|---|---|
| `mode` | `native` or `wsl` |
| `python` | interpreter to run — must have torch (`.venv311`, not `.venv`) |
| `repo_dir` | checkout holding `server.py` |
| `wsl_distro` / `wsl_repo_dir` / `wsl_python` | WSL2 backend, Windows only |
| `port` | preferred port, default 8765 |
| `extra_args` | extra CLI args appended to the `server.py` invocation |
| `hf_home` | override the HuggingFace cache location |
