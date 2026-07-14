# novel-tts — Local Audiobook Player for Pasted Text

**Date:** 2026-07-14
**Status:** Approved

## Purpose

The user reads light novels (English translations) but gets distracted reading on screen.
This tool turns pasted chapter text into a listen-along audiobook: paste text, press play,
and a local web player reads it aloud with the current passage highlighted, resumable at
any time.

## Requirements

- Runs fully locally on the user's machine (WSL2, Ryzen 7 5700X, RTX 4060 8GB, 15GB RAM).
- TTS engine: **Kokoro-82M** (Apache 2.0). Light enough to generate ~10x faster than
  realtime on the 4060 and to coexist with games; 54 built-in voices; default `af_heart`.
- Input flow: paste chapter text into a box in the web UI (primary) **or** edit
  `novel.txt` directly. The file is the source of truth.
- Playback: browser-based player with play/pause, per-paragraph jump, skip back/forward,
  speed control (0.75x–2x via `playbackRate`, pitch-preserved), voice picker.
- Position memory: per-chapter (keyed by text hash), stored server-side; resumes across
  tab closes, server restarts, and chapter switches.
- Audio must stay ahead of the listener (generate-ahead buffering).

## Architecture

Single Python process (FastAPI + uvicorn) at `~/novel-tts/`, started with `bash start.sh`,
serving the UI and API at `http://localhost:8765`. The browser (Windows side, via WSL2
localhost forwarding) handles all audio playback — no WSL audio stack involved.

### Components

1. **Chunker** (`chunker.py`) — pure logic, unit-tested.
   - Normalize text (BOM, line endings, collapse blank runs).
   - Split into paragraphs; split long paragraphs into sentence groups ≤ ~400 chars
     (Kokoro's stable input size).
   - Chunk ID = SHA-1 of `voice + "\x00" + chunk text`. Document ID = SHA-1 of full
     normalized text.

2. **TTS worker** (`tts.py`) — one background thread owning the Kokoro pipeline
   (GPU if available, else CPU).
   - Priority queue: chunk explicitly requested by the client first, then chunks
     `position .. position+8`.
   - Writes 24kHz WAV to `cache/{chunk_id}.wav`. Cache capped at 2GB, LRU-evicted
     by file mtime.
   - On generation failure: retry once, then mark chunk `failed` (client can re-request).

3. **API** (`server.py`)
   - `GET /api/doc` → `{doc_id, chunks: [{id, text, para}], mtime}`
   - `POST /api/doc` → replace `novel.txt` with pasted text
   - `GET /api/audio/{chunk_id}` → WAV bytes; prioritizes and waits for generation if
     not yet cached (bounded wait, then 503 so the client retries)
   - `GET /api/status` → per-chunk ready/failed map (for buffering indicator)
   - `GET /api/voices` → available Kokoro voices
   - `GET/POST /api/state` → `{positions: {doc_id: chunk_index}, voice, speed}` persisted
     to `state.json`
   - `GET /` → the player page (single static HTML file)

4. **Player UI** (`static/index.html`) — vanilla HTML/JS/CSS, no build step.
   - Chapter rendered as paragraphs; current chunk highlighted + auto-scrolled.
   - Controls: play/pause (Space), prev/next chunk (arrow keys), click paragraph to jump,
     speed slider, voice dropdown, paste-chapter modal.
   - Plays chunks via `<audio>` elements; prefetches the next chunk for near-gapless
     transitions. Failed chunks shown in red, click to retry, playback skips them.
   - Voice change invalidates chunk IDs → re-fetch doc, position preserved by index.

### Data flow

Paste (UI) → `POST /api/doc` writes `novel.txt` → server re-chunks → UI fetches new doc →
position looked up by `doc_id` (0 if new) → worker generates ahead → UI plays chunk WAVs
in sequence, posting position updates as it advances.

File edited externally → mtime poll (~1s) notices → same path as above.

## Error handling

- Chunk failure: retry once, mark failed, UI skips and flags it.
- `GET /api/audio` for missing chunk: worker prioritizes it; request waits up to ~30s
  then 503s; UI retries with backoff.
- Corrupt/empty `novel.txt`: UI shows "paste a chapter to begin" state.
- espeak-ng and model files verified at startup with a clear console message if missing.

## Testing

- Unit tests (pytest): chunker — paragraph splitting, long-paragraph sentence grouping,
  400-char bound, hash stability, normalization.
- Smoke test: generate one real chunk through Kokoro, assert non-trivial WAV output.
- End-to-end (manual, via verify): start server, paste sample text, play in browser,
  confirm highlight tracking, resume-after-restart, and speed control.

## Dependencies

- apt: `espeak-ng`
- Python 3.12 venv: `kokoro`, `torch` (CUDA wheel), `soundfile`, `fastapi`,
  `uvicorn`, `pytest` (dev)

## Addendum: UI v2 (2026-07-15)

The vanilla single-file player was replaced by a React + Vite + Tailwind 4 +
shadcn/ui frontend in `frontend/`, built into `static/` (built assets are
committed; the FastAPI server is unchanged as the host — Node 22 at `~/node22`
is only needed to modify the UI). User flow: slim top bar (title, Aa reading
menu, Paste chapter) + audiobook-style bottom player bar (voice picker,
transport, clickable progress strip, volume slider + mute, speed popover with
presets). New settings: **volume** (persisted server-side in `state.json`,
clamped 0–1, returned by `/api/doc`) and **reading preferences** (font
Georgia/Literata/Inter/System — Literata and Inter bundled locally — size,
line spacing, text width; persisted in localStorage). Theme: shadcn zinc dark,
`--radius: 0.25rem` (low border radius per user requirement). Errors surface
as sonner toasts instead of `alert()`. The playback engine
(`frontend/src/lib/player.ts`) is a verbatim port of the vanilla logic
(generation-token retry cancellation, failed-chunk skip, mid-chunk resume,
status polling, per-chapter resume), verified by line-by-line review.

**v2.1 (2026-07-15):** the voice picker became a searchable combobox
(shadcn Popover + Command pattern) grouped by US/UK × female/male; theme
settings were added to the Aa menu — mode light/dark/system plus five accent
colors (indigo default) driving the progress bar and current-sentence
highlight via `--accent-base` CSS vars, applied pre-paint by an inline
script in `index.html` and persisted in localStorage
(`novel-tts:theme`) — along with paragraph spacing, justify-text, and
auto-scroll reading options. The global UI font (everything outside the
chapter reading area, including the paste dialog) is **Geist**, bundled
locally via @fontsource-variable.

**v2.2 (2026-07-15):** animation polish. Theme/accent switches cross-fade
the page via the View Transitions API (300ms; skipped on unsupported
browsers and under prefers-reduced-motion), the current-sentence highlight
fades its ring in/out and pulses while its audio is still generating,
play/pause and volume icons zoom-fade on swap, the progress strip gained a
hover scrub knob, and the bars/reader/empty state get subtle one-time
entrance animations (all `motion-reduce:animate-none`).

**v2.3 (2026-07-15):** focused-reading overhaul. The current-sentence
highlight settles in with a contracting-ring keyframe (`.hl-current` /
`.hl-buffering` in index.css) while the sentence the voice just left fades
out over 700ms (trailing highlight, previous-index tracked in Reader).
Auto-scroll no longer uses native `scrollIntoView` (which snaps on short
distances): `useFollowChunk` in `lib/follow.ts` glides the sentence to a
reading line at 42% of the viewport with an ease-out rAF animation
(~330–800ms scaled by distance), repositions instantly on document
switch, and cancels when the user scrolls manually.

**v2.4 (2026-07-15):** motion.dev (the `motion` package, LazyMotion +
domAnimation, wrapped in `MotionConfig reducedMotion="user"`). Auto-scroll
follow now drives a MotionValue spring (stiffness 110 / damping 24, slightly
overdamped) so consecutive sentence advances inherit in-flight velocity —
one continuous teleprompter motion instead of restarted ease curves.
Play/pause and volume icons are stacked `m.span`s that spring cross-fade
(the outgoing icon animates away too), the progress fill is spring-driven
with the scrub knob riding its right edge, and paragraphs stagger in
(capped 0.4s) on chapter load, replacing the reader's slide-in entrance.

**v2.4.1 (2026-07-15):** focused-reading handoff fix (headless-verified).
Only one row may ever read as current: the leaving sentence now drops its
ring in 120ms and trails only a 450ms background wake (`.hl-leave`), the
incoming highlight settles in 300ms, and the follow spring is critically
damped (stiffness 170 / damping 26) so the glide leads the eye immediately
— soft springs start at zero velocity, which left the page static exactly
when the highlight changed rows. Scroll targets subtract the chapter
entrance stagger's residual translateY so doc-load lands on the final
layout position.

## Addendum: Inline illustrations (2026-07-15, v2.5)

Chapters copied from novel sites carry their illustrations as `<img>` URLs
in the clipboard's `text/html` flavor. The paste dialog now intercepts such
pastes (`lib/paste.ts` converts the HTML fragment to paragraph text,
preserving image positions), asks the server to download each image
(`POST /api/image/fetch`; direct bitmap pastes upload via `POST /api/image`),
and inserts `[img:<sha1-of-bytes>]` marker lines into the text. Markers are
plain lines in `novel.txt`: the chunker skips marker paragraphs (never sent
to TTS) and `doc_images()` reports them; `/api/doc` returns
`images: [{id, para, w, h}]` and `GET /api/image/{id}` serves the bytes
(immutable cache). `images.py` owns the content-addressed store
(`images/<sha1>`): pure-stdlib dimension sniffing for png/jpeg/gif/webp,
25MB per-image cap, 500MB LRU prune that spares images referenced by the
current chapter. The reader interleaves images between paragraphs at their
marker positions with explicit width/height (so late loads can't shift the
auto-scroll), column-width capped, click to open full size. Failed imports
drop the marker and surface a toast; plain-text pastes are unchanged.
Verified end-to-end on an isolated instance against a real Blogger chapter
clipboard capture.

## Addendum: Buffering under GPU contention (2026-07-15, v2.6)

With a game holding the GPU, Kokoro drops from ~10x to ~1x realtime (measured
via cache-write timestamps: 173s of audio in 152s of wall time), so playback
was outrunning the 8-chunk generate-ahead and every uncached chunk stalled for
its full audio length — worst for 400-char paragraph chunks (~25s of audio,
~25s stall). Two changes:

- `MAX_CHUNK_CHARS` 400 → **250**: worst-case time-to-first-audio ~16s → in
  practice ~12s per half-paragraph. 250 exceeds the longest real sentence
  observed (246 chars over 1029 sentences sampled), so sentences still never
  hard-split mid-flow; highlight granularity tightens accordingly.
- The lookahead window is now **time-based** (`LOOKAHEAD_SECONDS = 180`,
  estimated at 15 chars/s, capped at `LOOKAHEAD_MAX_CHUNKS = 64`) instead of
  a fixed 8 chunks: 8 short dialogue lines only buffered ~15s of audio, which
  is exactly when a near-realtime generator gets caught by a long paragraph.
  The worker now builds ~3 minutes of cushion whenever the GPU has headroom
  (menus, pauses), absorbing contention spikes.

Re-chunking changes chunk ids (long-paragraph audio regenerates; short
paragraphs keep their cache) and shifts saved positions slightly backwards —
a small rewind, never a skip.

## Out of scope (deliberately)

- MP3/M4B export (possible later "export" button; cache design already supports it).
- Voice cloning / Chatterbox backend (revisit if narration quality disappoints).
- Multi-file library management — one working file keeps the paste flow simple;
  per-chapter positions already survive switching text back and forth.
- EPUB parsing, Japanese support.
