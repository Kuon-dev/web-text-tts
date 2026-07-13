# novel-tts

Local audiobook player for pasted light-novel text. Kokoro-82M TTS, browser player.

## Use

    bash start.sh          # then open http://localhost:8765 in your Windows browser

Paste a chapter (button top right, or edit `novel.txt`), press Play.

- Space = play/pause · ←/→ = skip chunk · click any sentence to jump
- Speed slider (pitch-preserved) · voice dropdown (Kokoro English voices)
- Your position is saved per chapter — close anything, it resumes.
- Audio cache: `cache/` (2 GiB cap, auto-evicted). State: `state.json`.

## Dev

    .venv/bin/pytest -m "not slow"    # fast suite
    .venv/bin/pytest -m slow          # real-model smoke test
