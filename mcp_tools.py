"""Tool bodies for the MCP connector: a web page in, the reader's document out.

Plain functions over AppState, with no dependency on the `mcp` package — the
protocol wiring lives in mcp_app.py, so everything here is testable directly.
"""
import logging

from chunker import doc_id as _doc_id
from images import ImageError
from webpage import IMG_PLACEHOLDER, PageError, extract_page, fetch_html

log = logging.getLogger("novel-tts")

MAX_IMAGES = 20
MAX_TEXT_CHARS = 200_000


def _require_text(text: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text is empty")
    return text.strip()


def _summary(st) -> dict:
    return {"doc_id": st.doc_id,
            "paragraphs": len([line for line in st.text.split("\n") if line.strip()]),
            "chunks": len(st.chunks),
            "position": st.position()}


def _import_images(st, page) -> tuple[str, int]:
    """Swap @@IMGn@@ placeholders for [img:<sha1>] markers, dropping failures."""
    text = page.text
    imported = 0
    for n, url in enumerate(page.image_urls):
        marker = ""
        if imported < MAX_IMAGES:
            try:
                marker = "[img:%s]" % st.images.fetch(url)["id"]
                imported += 1
            except (ImageError, OSError) as exc:
                log.info("skipping image %s: %s", url, exc)
        text = text.replace(IMG_PLACEHOLDER(n), marker)
    # A dropped image leaves an empty line; collapse it so the paragraph count
    # the agent sees matches what the reader will show.
    return "\n\n".join(line for line in text.split("\n") if line.strip()), imported


def fetch_page(st, url: str) -> dict:
    """Download a page and return its chapter text. Mutates no document state."""
    html, final_url = fetch_html(url)
    page = extract_page(html, final_url)
    text, imported = _import_images(st, page)
    truncated = len(text) > MAX_TEXT_CHARS
    if truncated:
        cut = text[:MAX_TEXT_CHARS]
        text = cut[:cut.rfind("\n")] if "\n" in cut else cut
    if not text.strip():
        raise PageError("no readable text found on that page")
    return {"title": page.title, "url": final_url, "text": text, "chars": len(text),
            "paragraphs": len([line for line in text.split("\n") if line.strip()]),
            "images": imported, "truncated": truncated}


def load_text(st, text: str) -> dict:
    """Replace the reader's document — the same path as pasting a chapter."""
    text = _require_text(text)
    with st.lock:
        st.load_doc(text)
        return _summary(st)


def append_text(st, text: str) -> dict:
    """Add a section to the end of the document, keeping the listener's place.

    positions and bookmarks are both keyed by doc_id and doc_id is a hash of
    the text, so an append mints a new key: without carrying the old entries
    over first, load_doc would hand the worker position 0 and the reader would
    jump to the top, and every mark in the chapter would vanish. An append
    preserves the chunk prefix, so every stored index stays valid.
    """
    text = _require_text(text)
    with st.lock:
        base = st.text.strip()
        combined = f"{base}\n\n{text}" if base else text
        new_id = _doc_id(combined)
        pos = st.state["positions"].get(st.doc_id)
        # `is not None`, not truthiness: position 0 is a real position, and a
        # bookmark on the first sentence is a real bookmark.
        if pos is not None:
            st.state["positions"][new_id] = pos
        marks = st.state["bookmarks"].get(st.doc_id)
        if marks:
            st.state["bookmarks"][new_id] = marks
        st.load_doc(combined)
        st.save_state()
        return _summary(st)


def get_status(st) -> dict:
    """What the reader is doing right now.

    Lock-free for the same reason GET /api/status is: it must not block behind an
    in-flight engine swap. Reads the voice out of state rather than calling
    st.voice(), which would mutate it.
    """
    chunks = st.chunks
    pos = st.position()
    worker = st.worker.status()
    info = st.manager.info()
    return {"doc_id": st.doc_id,
            "chunks": len(chunks),
            "position": pos,
            "current_text": chunks[pos].text if chunks else "",
            "engine": info.get("engine"),
            "voice": st.state["voices"].get(st.manager.engine_id, ""),
            "device_mode": info.get("mode"),
            "ready": len(worker["ready"]),
            "failed": len(worker["failed"]),
            "blocked": worker["blocked"]}
