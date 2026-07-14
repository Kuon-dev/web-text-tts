# novel-tts

Local audiobook player for pasted light-novel text. Kokoro-82M TTS, browser player.

## Use

    bash start.sh          # then open http://localhost:8765 in your Windows browser

Paste a chapter (button top right, or edit `novel.txt`), press Play.

- Space = play/pause · ←/→ = skip chunk · click any sentence to jump
- Bottom player bar: searchable voice combobox (grouped US/UK, female/male),
  transport, volume + mute, speed popover, clickable chapter-progress strip
- Aa menu (top right): theme (light / dark / system) + accent color, reading font
  (Georgia / Literata / Inter / System), size, line & paragraph spacing, text
  width, justify, auto-scroll — saved in the browser
- Position (per chapter), voice, speed, and volume are saved — close anything, it resumes.
- Audio cache: `cache/` (2 GiB cap, auto-evicted). State: `state.json`.

## Dev

    .venv/bin/pytest -m "not slow"    # fast suite
    .venv/bin/pytest -m slow          # real-model smoke test

### UI (React + Vite + shadcn/ui, in `frontend/`)

    export PATH=~/node22/bin:$PATH
    cd frontend
    npm install            # once
    npm run build          # emits the served app into ../static
    npm run dev            # live-reload dev server on :5173, proxies /api to :8765

The server serves the prebuilt `static/` — Node is only needed to change the UI.
