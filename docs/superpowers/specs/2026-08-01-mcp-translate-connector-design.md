# MCP Connector — Translate a Website Into the Reader

**Date:** 2026-08-01
**Status:** Design approved
**Extends:** `2026-07-14-novel-tts-design.md`, `2026-07-23-pluggable-tts-engines-design.md`

## Purpose

Let an AI agent point at a web page, translate it, and have the translation appear in
the reader for the TTS to speak — without anyone touching the paste dialog.

The agent supplies the translation. The server supplies two things the agent is bad at:
a clean extraction of the page's chapter text (nav, ads and footers removed,
illustrations preserved) and a way to put text into the running document. Nothing in
this feature calls a translation API, holds an API key, or costs money per page.

## Requirements

- The connector speaks MCP over streamable HTTP at `http://localhost:8765/mcp`, served
  by the FastAPI app that already runs the reader. No second process.
- Translation is done by the calling agent. The server never translates.
- `fetch_page` returns reader-quality text: main content only, one paragraph per line,
  illustrations imported into the existing image store as `[img:<sha1>]` marker lines.
- Loading text is equivalent to a paste: `novel.txt` is written, the document is
  rechunked, the worker is redirected — and the open browser picks it up on its own.
- Appending must not lose the listener's place, and should not stop playback.
- The reader must still boot and work if the `mcp` package is not installed.
- The fast test suite (`pytest -m "not slow"`) stays green without torch.

## Architecture

```
webpage.py    fetch_html(url) · extract_page(html, base_url) -> PageContent
              bs4; main-content heuristic; no knowledge of the TTS app
mcp_tools.py  the four tool bodies as plain functions over AppState
              does NOT import mcp — all real logic testable without the SDK
mcp_app.py    MCPServer("novel-tts"): registers the tools, returns the ASGI app
server.py     mounts /mcp, runs mcp.session_manager.run() in the existing lifespan
```

The layering exists so that the part most likely to need tuning (extraction) and the
part that touches shared state (the tools) are both testable without an MCP client,
and so a missing SDK degrades to "no `/mcp` route" instead of a boot failure.

### Data flow

```
agent → fetch_page(url) ───► download, extract, import images, return text
        (agent translates)
agent → load_text(text) ───► novel.txt written · rechunk · worker.set_doc
                             ↓  browser polls /api/status every 1s
                             open page sees a new doc_id, reloads, audio generates
```

No push channel is needed: `frontend/src/lib/player.ts` already reloads the document
whenever the polled `doc_id` differs from the one it holds.

## Tools

### `fetch_page(url)` — read-only

Downloads and extracts. Touches no application state.

- `http`/`https` only; 30 s timeout; 5 MB download cap; browser-like User-Agent
  (matching `images.py`, which the same sites are already serving illustrations to).
- Non-HTML content types are rejected with a clear message.
- Extraction (see below) yields title + paragraphs.
- Up to 20 images per page are resolved against the page URL and imported via
  `ImageStore.fetch`; each becomes an `[img:<sha1>]` line in place. Failures are logged
  and skipped, never fatal — a chapter without its illustration still reads.
- Extracted text is capped at 200 000 characters; truncation is reported in the result.
- Returns `{title, url, text, chars, paragraphs, images}`.

Its tool description states the contract the agent must honour when translating:
**one paragraph per line, `[img:…]` lines copied through verbatim and in place.**
That is what keeps illustrations anchored to the right paragraph after translation.

### `load_text(text)`

Replaces the document. Same code path as `POST /api/doc`: write `novel.txt`, rechunk,
prune unreferenced images, redirect the worker. Returns
`{doc_id, paragraphs, chunks, position}`.

### `append_text(text)`

Appends a section to the current document, for translating a chapter page by page.
Separated from the previous text by a blank line. Returns the same shape as `load_text`.

`positions` is keyed by `doc_id`, and `doc_id` is a hash of the text — so appending
mints a new key and would drop the listener to chunk 0. `append_text` therefore carries
`positions[old_id]` to `positions[new_id]` before saving state.

### `get_status()`

`doc_id`, chunk count, current position and the text at it, engine / voice / device
mode, counts of ready and failed chunks, and the `blocked` reason when generation is
waiting on GPU contention. This is how an agent confirms a load landed and reports
progress back, instead of guessing.

### Deliberately absent

- **No `extract_text(html)` escape hatch.** For a JS-rendered or login-walled page the
  agent fetches with its own web tool and calls `load_text` directly — the gap closes
  itself.
- **No voice/engine tools.** Voice selection stays a human decision in the UI.
- **No play/pause/seek.** Playback lives in the browser; driving it from the server
  needs a push channel, which is a larger feature than this one.

## Concurrency

Every document mutation takes `st.lock`, exactly as the HTTP handlers do. MCP tools run
on the event loop, and `load_doc` does file IO, chunking and a worker handoff — so each
tool is `async def` with its blocking body in `await asyncio.to_thread(...)`. `fetch_page`
does network IO and is offloaded the same way.

`get_status` follows `GET /api/status` and reads without the lock: it must not freeze
behind a multi-second engine swap, and the fields it reads are rebound atomically.

## Frontend

One change, in `player.ts`'s `pollStatus`: on a `doc_id` change, if playback was running
and the chunk id currently playing still exists in the new document, resume at it rather
than pausing. Without this, an agent appending page 2 stops the audio you are listening
to on page 1.

## Error handling

Tool failures surface to the agent as MCP tool errors with a plain-language message:
unreachable host, non-HTML response, page over the size cap, extraction found no text,
empty `text` argument. Nothing partially applies — `fetch_page` mutates nothing, and
`load_text` / `append_text` validate before writing.

## Security

Unchanged posture. The server binds `127.0.0.1`; the MCP endpoint inherits that and has
no auth, exactly like the existing API. `fetch_page` accepts only `http`/`https` URLs.
Any process on the machine can reach the endpoint, which is already true of `/api/doc`.

## Testing

- `tests/test_webpage.py` — extraction from fixture HTML: `<article>`/`<main>`/
  `[role=main]` preference, density scoring when no semantic container exists, fallback
  to `<body>` when the winner is implausibly thin, boilerplate stripping,
  `<br>`/block-tag line handling, relative image URL resolution, malformed markup.
- `tests/test_mcp_tools.py` — the four tools against a real `AppState` with the existing
  `FakeWorker` / `FakeManager` and a monkeypatched fetcher: load replaces, append
  preserves position, image markers survive, status shape.
- `tests/test_mcp_endpoint.py` — `importorskip("mcp")`; initialize, `list_tools`, and one
  `call_tool` over the mounted ASGI app via httpx `ASGITransport`.

## Dependencies

`mcp` and `beautifulsoup4` are added to `requirements.txt`. Both are pure Python and
small next to torch. `mcp` requires Python ≥ 3.10; the project venv is 3.14.

## Out of scope

Translation memory or caching of past translations, a chapter library (the app holds one
document by design), scheduled/automatic re-fetching, and any server-side LLM call.
