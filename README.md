# novel-tts

Local audiobook player for pasted light-novel text. Kokoro-82M / Qwen3-TTS, browser player.

## Use

    bash start.sh          # then open http://localhost:8765 in your Windows browser

Paste a chapter (button top right, or edit `novel.txt`), press Play.

- Space = play/pause · ←/→ = skip chunk · click any sentence to jump
- Bottom player bar: searchable voice combobox (grouped by engine/language),
  transport, volume + mute, speed popover, clickable chapter-progress strip
- Engine picker (settings): **Kokoro-82M** (default, 16 voices; falls back to CPU
  under GPU contention) or **Qwen3-TTS 0.6B** (9 preset speakers incl. native
  Japanese, GPU-only; pauses generation when GPU is busy — playback waits, UI
  explains why). Switching engine regenerates cached audio; per-engine voice memory.
- Aa menu (top right): theme (light / dark / system) + accent color, reading font
  (Georgia / Literata / Inter / System), size, line & paragraph spacing, text
  width, justify, auto-scroll — saved in the browser
- Position (per chapter), voice, speed, and volume are saved — close anything, it resumes.
- Audio cache: `cache/` (2 GiB cap, auto-evicted). Switching engine, changing style
  instruction, or replacing a clone's reference clip regenerates that voice's
  cached audio. State: `state.json`.

## Qwen3-TTS extras

First use downloads ~1.8 GB per model variant (CustomVoice for preset voices, Base
for cloning).

- **Style instruction** (settings, Qwen3 only): "read calmly…" etc. Applies to
  preset voices; regenerates audio if changed.
- **Voice cloning** (settings, 3–30s audio clip): Upload a reference clip in
  settings; the cloned voice appears in the combobox under "Cloned".

## Dev

    .venv/bin/pytest -m "not slow"    # fast suite (runs without torch/qwen-tts)
    .venv/bin/pytest -m slow          # real-model smoke test

Engines live in the `tts/` package (base contract, DevicePolicy, registry,
manager). Fast suite runs all unit tests without requiring torch or qwen-tts;
real-model tests are marked `-m slow`.

### UI (React + Vite + shadcn/ui, in `frontend/`)

    export PATH=~/node22/bin:$PATH
    cd frontend
    npm install            # once
    npm run build          # emits the served app into ../static
    npm run dev            # live-reload dev server on :5173, proxies /api to :8765

The server serves the prebuilt `static/` — Node is only needed to change the UI.
