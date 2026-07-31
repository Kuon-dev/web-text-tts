# MCP Translate Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an AI agent fetch a web page, translate it itself, and push the translation into the running TTS reader over an MCP endpoint served by the existing app.

**Architecture:** `webpage.py` fetches and extracts chapter text (bs4, main-content heuristic, no app knowledge). `mcp_tools.py` holds the four tool bodies as plain functions over `AppState` and never imports `mcp`, so the logic is testable without the SDK. `mcp_app.py` registers them on an `MCPServer`. `server.py` copies the streamable-HTTP route onto its router and runs the session manager in its existing lifespan.

**Tech Stack:** Python 3.14 (`.venv`), FastAPI, `mcp` 2.0.0, beautifulsoup4 4.15, pytest, React/Vite frontend.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-mcp-translate-connector-design.md`.
- Fast suite must stay green without torch: `.venv/bin/pytest -m "not slow"`.
- The reader must still boot when `mcp` is not installed — the import is guarded.
- Tools are plain `def`, never `async def`: the SDK runs sync tool bodies on an AnyIO worker thread.
- Every document mutation takes `st.lock`; `get_status` takes no lock.
- Download caps: 5 MB HTML, 30 s timeout, 20 images per page, 200 000 characters of extracted text.
- `http`/`https` URLs only.
- Server keeps binding `127.0.0.1`; no auth is added.
- Two virtualenvs exist: `.venv` (3.14, what tests use) and `.venv311` (3.11, holds torch/kokoro — what actually serves). New deps go in **both**.

## File Structure

| File | Responsibility |
|---|---|
| `webpage.py` (create) | `fetch_html(url)`, `extract_page(html, base_url)` → `PageContent`. Knows HTML, not the app. |
| `mcp_tools.py` (create) | `fetch_page`/`load_text`/`append_text`/`get_status` over `AppState`. No `mcp` import. |
| `mcp_app.py` (create) | `build_mcp(st)` → `MCPServer` with the tools and their agent-facing descriptions. |
| `server.py` (modify) | Build + mount the MCP route; run the session manager in the existing lifespan. |
| `frontend/src/lib/player.ts` (modify) | Keep playing across a `doc_id` change when the current chunk survives. |
| `tests/test_webpage.py` (create) | Extraction behaviour. |
| `tests/test_mcp_tools.py` (create) | Tool behaviour against a real `AppState`. |
| `tests/test_mcp_endpoint.py` (create) | Protocol-level smoke test over the mounted app. |
| `requirements.txt`, `README.md` (modify) | Deps and connector docs. |

---

### Task 1: Page fetching and extraction

**Files:**
- Create: `webpage.py`
- Create: `tests/test_webpage.py`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `class PageError(ValueError)`
  - `@dataclass(frozen=True) class PageContent: title: str; text: str; image_urls: list[str]`
  - `fetch_html(url: str) -> tuple[str, str]` — returns `(html, final_url)`
  - `extract_page(html: str, base_url: str = "") -> PageContent`
  - `IMG_PLACEHOLDER(n: int) -> str` returning `f"@@IMG{n}@@"`
  - Constants `MAX_HTML_BYTES`, `FETCH_TIMEOUT`

- [ ] **Step 1: Install deps and record them**

```bash
.venv/bin/pip install mcp beautifulsoup4
.venv311/bin/pip install mcp beautifulsoup4
```

Append to `requirements.txt` (after `httpx`):

```
beautifulsoup4
mcp
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_webpage.py`:

```python
import pytest

from webpage import PageContent, PageError, extract_page, fetch_html


def test_prefers_article_over_page_chrome():
    html = """
    <html><head><title>Chapter 12 - Site</title></head><body>
      <nav><a href="/">Home</a><a href="/next">Next</a></nav>
      <header>Site banner</header>
      <article>
        <p>The knight drew her sword.</p>
        <p>The dragon did not move.</p>
      </article>
      <footer>Copyright 2026</footer>
    </body></html>
    """
    page = extract_page(html)
    assert page.title == "Chapter 12 - Site"
    assert page.text == "The knight drew her sword.\n\nThe dragon did not move."


def test_density_heuristic_picks_deepest_container_holding_the_prose():
    html = """
    <html><body>
      <div id="wrapper">
        <div id="sidebar"><p>Ads</p><a href="#">Link</a></div>
        <div id="content">
          <p>Snow fell on the quiet town for the third day running.</p>
          <p>Nobody had come down the mountain road since Tuesday.</p>
        </div>
      </div>
    </body></html>
    """
    page = extract_page(html)
    assert "Snow fell" in page.text
    assert "Ads" not in page.text


def test_falls_back_to_body_when_semantic_container_is_thin():
    html = """
    <html><body>
      <main><p>Loading</p></main>
      <div><p>%s</p><p>%s</p></div>
    </body></html>
    """ % ("A" * 300, "B" * 300)
    page = extract_page(html)
    assert "A" * 300 in page.text
    assert "B" * 300 in page.text


def test_br_and_block_tags_become_paragraph_breaks():
    html = "<body><article><p>One<br>Two</p><div>Three</div></article></body>"
    assert extract_page(html).text == "One\n\nTwo\n\nThree"


def test_script_and_style_never_reach_the_reader():
    html = """
    <body><article>
      <script>var x = 'do not read me';</script>
      <style>.a { color: red }</style>
      <p>Only this.</p>
    </article></body>
    """
    assert extract_page(html).text == "Only this."


def test_images_become_placeholders_with_absolute_urls():
    html = """
    <body><article>
      <p>Before.</p>
      <img src="../img/plate1.png">
      <p>After.</p>
    </article></body>
    """
    page = extract_page(html, "https://example.com/novel/ch12.html")
    assert page.image_urls == ["https://example.com/img/plate1.png"]
    assert page.text == "Before.\n\n@@IMG0@@\n\nAfter."


def test_lazy_loaded_images_use_data_src():
    html = '<body><article><img src="spacer.gif" data-src="/real.jpg"><p>Hi.</p></article></body>'
    page = extract_page(html, "https://example.com/a/b")
    assert page.image_urls == ["https://example.com/real.jpg"]


def test_malformed_markup_still_yields_paragraphs_in_order():
    html = "<body><article><p>First<p>Second</div><p>Third</article></body>"
    assert extract_page(html).text == "First\n\nSecond\n\nThird"


def test_title_falls_back_to_h1():
    html = "<body><article><h1>Chapter 3</h1><p>Text here.</p></article></body>"
    assert extract_page(html).title == "Chapter 3"


def test_whitespace_inside_a_paragraph_collapses():
    html = "<body><article><p>a\n   b\tc</p></article></body>"
    assert extract_page(html).text == "a b c"


def test_empty_document_raises():
    with pytest.raises(PageError):
        extract_page("<html><body></body></html>")


def test_fetch_rejects_non_http_urls():
    with pytest.raises(PageError, match="http"):
        fetch_html("file:///etc/passwd")


def test_fetch_rejects_non_html_content(monkeypatch):
    monkeypatch.setattr("webpage._open", lambda url: (b"\x89PNG", "image/png", None, url))
    with pytest.raises(PageError, match="not an HTML page"):
        fetch_html("https://example.com/a.png")


def test_fetch_decodes_with_the_header_charset(monkeypatch):
    body = "<html><body><article><p>ねこ</p></article></body></html>".encode("euc-jp")
    monkeypatch.setattr("webpage._open", lambda url: (body, "text/html", "euc-jp", url))
    html, final = fetch_html("https://example.com/a")
    assert "ねこ" in html
    assert final == "https://example.com/a"


def test_fetch_decodes_with_the_meta_charset_when_the_header_omits_it(monkeypatch):
    body = '<html><head><meta charset="shift_jis"></head><body><p>ねこ</p></body></html>'.encode("shift_jis")
    monkeypatch.setattr("webpage._open", lambda url: (body, "text/html", None, url))
    html, _ = fetch_html("https://example.com/a")
    assert "ねこ" in html


def test_fetch_rejects_oversized_pages(monkeypatch):
    import webpage
    monkeypatch.setattr(webpage, "MAX_HTML_BYTES", 10)
    monkeypatch.setattr("webpage._open", lambda url: (b"x" * 11, "text/html", "utf-8", url))
    with pytest.raises(PageError, match="too large"):
        fetch_html("https://example.com/a")


def test_page_content_is_a_frozen_dataclass():
    page = PageContent(title="t", text="x", image_urls=[])
    with pytest.raises(Exception):
        page.title = "other"  # type: ignore[misc]
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `.venv/bin/pytest tests/test_webpage.py -q`
Expected: collection error — `ModuleNotFoundError: No module named 'webpage'`.

- [ ] **Step 4: Write `webpage.py`**

```python
"""Fetch a web page and extract its chapter text — the read side of the MCP connector.

Deliberately knows nothing about the TTS app: it turns HTML into paragraphs and a
list of image URLs, and lets the caller decide what to do with them.
"""
import logging
import re
import urllib.request
from dataclasses import dataclass
from urllib.parse import urljoin

from bs4 import BeautifulSoup, NavigableString, Tag

log = logging.getLogger("novel-tts")

MAX_HTML_BYTES = 5 * 1024 * 1024
FETCH_TIMEOUT = 30.0
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) novel-tts/1.0"

# Chrome, not chapter: never speak any of it.
SKIP_TAGS = {"script", "style", "noscript", "template", "head", "iframe", "svg",
             "button", "nav", "header", "footer", "aside", "form", "select", "textarea"}

# Same list the browser-side paste extractor uses (frontend/src/lib/paste.ts):
# these tags end a line, everything else is inline.
BLOCK_TAGS = {"address", "article", "aside", "blockquote", "dd", "details", "div", "dl",
              "dt", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
              "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section",
              "table", "td", "th", "tr", "ul"}

# A paragraph shorter than this is furniture ("Home", "Next »"), not prose, and
# does not count toward a container's score.
MIN_PARA_CHARS = 25
# A semantic container with less text than this lost a fight with a paywall or a
# spinner; fall back to scoring the whole body instead.
MIN_MAIN_CHARS = 200

_META_CHARSET = re.compile(rb"""<meta[^>]+charset=['"]?\s*([\w-]+)""", re.I)


class PageError(ValueError):
    """User-facing failure (bad url, not HTML, too big, nothing to read)."""


@dataclass(frozen=True)
class PageContent:
    title: str
    text: str
    image_urls: list[str]


def IMG_PLACEHOLDER(n: int) -> str:
    return f"@@IMG{n}@@"


def _open(url: str) -> tuple[bytes, str, str | None, str]:
    """(body, content_type, charset, final_url). Seam for tests."""
    req = urllib.request.Request(
        url, headers={"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml,*/*"}
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        return (resp.read(MAX_HTML_BYTES + 1), resp.headers.get_content_type(),
                resp.headers.get_content_charset(), resp.geturl())


def fetch_html(url: str) -> tuple[str, str]:
    """Download an http(s) page. Returns (html, final_url after redirects)."""
    if not url.startswith(("http://", "https://")):
        raise PageError("only http(s) URLs are supported")
    try:
        body, ctype, charset, final_url = _open(url)
    except PageError:
        raise
    except Exception as exc:
        raise PageError(f"download failed: {exc}") from exc
    if ctype not in ("text/html", "application/xhtml+xml", "text/plain"):
        raise PageError(f"not an HTML page (content-type: {ctype})")
    if len(body) > MAX_HTML_BYTES:
        raise PageError("page too large (5MB max)")
    if not charset:
        m = _META_CHARSET.search(body[:4096])
        charset = m.group(1).decode("ascii", "replace") if m else "utf-8"
    try:
        html = body.decode(charset, errors="replace")
    except LookupError:                       # server named an encoding python lacks
        html = body.decode("utf-8", errors="replace")
    return html, final_url


def _para_score(node: Tag) -> int:
    """Total length of the real prose inside a container."""
    return sum(len(t) for p in node.find_all(("p", "li"))
               if len(t := p.get_text(" ", strip=True)) >= MIN_PARA_CHARS)


def _depth(node: Tag) -> int:
    return len(list(node.parents))


def _main_node(soup: BeautifulSoup) -> Tag | None:
    body = soup.body or soup
    for node in (soup.find("article"), soup.find("main"), soup.find(attrs={"role": "main"})):
        if isinstance(node, Tag) and len(node.get_text(" ", strip=True)) >= MIN_MAIN_CHARS:
            return node
    candidates = [n for n in body.find_all(("div", "section", "article", "main", "td"))
                  if isinstance(n, Tag)]
    scored = [(s, _depth(n), n) for n in candidates if (s := _para_score(n))]
    if scored:
        # Highest score wins; on a tie the deepest node wins, which is the
        # innermost wrapper that still holds every paragraph — the article body
        # rather than its four layout ancestors, all of which score identically.
        best = max(scored, key=lambda e: (e[0], e[1]))
        return best[2]
    return body if isinstance(body, Tag) else None


def _flatten(node: Tag, out: list[str], urls: list[str], base_url: str) -> None:
    for child in node.children:
        if type(child) is NavigableString:
            out.append(re.sub(r"\s+", " ", str(child)))
            continue
        if not isinstance(child, Tag):
            continue                          # comments, doctype, CDATA
        name = (child.name or "").lower()
        if name in SKIP_TAGS:
            continue
        if name == "img":
            src = child.get("data-src") or child.get("src") or ""
            if isinstance(src, str) and src.strip():
                out.append(f"\n{IMG_PLACEHOLDER(len(urls))}\n")
                urls.append(urljoin(base_url, src.strip()) if base_url else src.strip())
            continue
        if name == "br":
            out.append("\n")
            continue
        block = name in BLOCK_TAGS
        if block:
            out.append("\n")
        _flatten(child, out, urls, base_url)
        if block:
            out.append("\n")


def _title(soup: BeautifulSoup) -> str:
    if soup.title and soup.title.string:
        return re.sub(r"\s+", " ", soup.title.string).strip()
    h1 = soup.find("h1")
    return re.sub(r"\s+", " ", h1.get_text(" ", strip=True)) if isinstance(h1, Tag) else ""


def extract_page(html: str, base_url: str = "") -> PageContent:
    """Chapter text from a web page: one paragraph per line, images as placeholders."""
    soup = BeautifulSoup(html, "html.parser")
    node = _main_node(soup)
    if node is None:
        raise PageError("no readable text found on that page")
    out: list[str] = []
    urls: list[str] = []
    _flatten(node, out, urls, base_url)
    lines = [re.sub(r"\s+", " ", line).strip() for line in "".join(out).split("\n")]
    text = "\n\n".join(line for line in lines if line)
    if not text:
        raise PageError("no readable text found on that page")
    return PageContent(title=_title(soup), text=text, image_urls=urls)
```

- [ ] **Step 5: Run the tests until they pass**

Run: `.venv/bin/pytest tests/test_webpage.py -q`
Expected: all pass. If `test_falls_back_to_body_when_semantic_container_is_thin` fails, check `MIN_MAIN_CHARS` gating in `_main_node`; if `test_density_heuristic_picks_deepest_container_holding_the_prose` fails, check the `(score, depth)` tie-break.

- [ ] **Step 6: Confirm nothing else broke**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: full fast suite passes.

- [ ] **Step 7: Commit**

```bash
git add webpage.py tests/test_webpage.py requirements.txt
git commit -m "feat: web page fetch + chapter-text extraction for the MCP connector"
```

---

### Task 2: Tool bodies over AppState

**Files:**
- Create: `mcp_tools.py`
- Create: `tests/test_mcp_tools.py`

**Interfaces:**
- Consumes: `webpage.fetch_html`, `webpage.extract_page`, `webpage.PageError`, `webpage.IMG_PLACEHOLDER`; `server.AppState` (attributes `lock`, `text`, `doc_id`, `chunks`, `state`, `images`, `worker`, `manager`, `load_doc`, `save_state`, `position`); `images.ImageError`; `chunker.doc_id`.
- Produces:
  - `fetch_page(st, url: str) -> dict` with keys `title, url, text, chars, paragraphs, images, truncated`
  - `load_text(st, text: str) -> dict` with keys `doc_id, paragraphs, chunks, position`
  - `append_text(st, text: str) -> dict` — same keys as `load_text`
  - `get_status(st) -> dict` with keys `doc_id, chunks, position, current_text, engine, voice, device_mode, ready, failed, blocked`
  - Constants `MAX_IMAGES = 20`, `MAX_TEXT_CHARS = 200_000`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_mcp_tools.py`:

```python
import pytest

import mcp_tools
from server import AppState
from tests.test_server import FakeManager, FakeWorker


@pytest.fixture
def st(tmp_path):
    worker = FakeWorker(tmp_path / "cache")
    state = AppState(tmp_path, worker, FakeManager())
    state.load_doc("First line.\n\nSecond line.")
    return state


def test_load_text_replaces_the_document(st):
    out = mcp_tools.load_text(st, "Brand new chapter.")
    assert st.text.strip() == "Brand new chapter."
    assert out["chunks"] == 1
    assert out["position"] == 0
    assert out["doc_id"] == st.doc_id
    assert (st.novel_path.read_text()).strip() == "Brand new chapter."


def test_load_text_rejects_blank_input(st):
    with pytest.raises(ValueError, match="empty"):
        mcp_tools.load_text(st, "   \n  ")


def test_append_text_keeps_the_earlier_text(st):
    mcp_tools.append_text(st, "Third line.")
    assert "First line." in st.text
    assert st.text.strip().endswith("Third line.")


def test_append_text_preserves_the_listeners_position(st):
    st.state["positions"][st.doc_id] = 1
    st.load_doc()                                   # re-enter with the saved position
    out = mcp_tools.append_text(st, "Third line.")
    assert out["position"] == 1
    assert st.state["positions"][st.doc_id] == 1
    assert st.worker.docs[-1][3] == 1               # worker was handed position 1


def test_append_text_clamps_a_position_past_the_new_end(st):
    st.state["positions"][st.doc_id] = 1
    mcp_tools.load_text(st, "Only one chunk now.")
    st.state["positions"][st.doc_id] = 0
    out = mcp_tools.append_text(st, "Another.")
    assert out["position"] == 0


def test_append_to_an_empty_document_just_loads(st):
    mcp_tools.load_text(st, "x")
    st.load_doc("")
    out = mcp_tools.append_text(st, "Fresh start.")
    assert st.text.strip() == "Fresh start."
    assert out["chunks"] == 1


def test_get_status_reports_the_document_and_engine(st):
    st.state["positions"][st.doc_id] = 1
    st.load_doc()
    out = mcp_tools.get_status(st)
    assert out["doc_id"] == st.doc_id
    assert out["chunks"] == 2
    assert out["position"] == 1
    assert out["current_text"] == "Second line."
    assert out["engine"] == "kokoro"
    assert out["voice"] == "af_heart"
    assert out["ready"] == 0
    assert out["blocked"] is None


def test_get_status_on_an_empty_document(st):
    st.load_doc("")
    out = mcp_tools.get_status(st)
    assert out["chunks"] == 0
    assert out["current_text"] == ""


def test_fetch_page_returns_extracted_text_without_touching_the_document(st, monkeypatch):
    html = "<html><head><title>Ch 1</title></head><body><article><p>%s</p></article></body></html>" % ("word " * 60)
    monkeypatch.setattr(mcp_tools, "fetch_html", lambda url: (html, url))
    before = st.doc_id
    out = mcp_tools.fetch_page(st, "https://example.com/ch1")
    assert out["title"] == "Ch 1"
    assert "word" in out["text"]
    assert out["paragraphs"] == 1
    assert out["images"] == 0
    assert out["truncated"] is False
    assert st.doc_id == before                       # read-only


def test_fetch_page_imports_images_as_markers(st, monkeypatch):
    html = ('<body><article><p>Before the plate.</p><img src="/p1.png">'
            '<p>After the plate.</p></article></body>')
    monkeypatch.setattr(mcp_tools, "fetch_html", lambda url: (html, url))
    monkeypatch.setattr(st.images, "fetch", lambda url: {"id": "a" * 40, "w": 4, "h": 4})
    out = mcp_tools.fetch_page(st, "https://example.com/ch1")
    assert "[img:%s]" % ("a" * 40) in out["text"]
    assert out["images"] == 1


def test_fetch_page_drops_images_it_cannot_import(st, monkeypatch):
    from images import ImageError
    html = '<body><article><p>Before the plate.</p><img src="/p1.png"><p>After.</p></article></body>'
    monkeypatch.setattr(mcp_tools, "fetch_html", lambda url: (html, url))
    def boom(url):
        raise ImageError("404")
    monkeypatch.setattr(st.images, "fetch", boom)
    out = mcp_tools.fetch_page(st, "https://example.com/ch1")
    assert "@@IMG" not in out["text"]
    assert "[img:" not in out["text"]
    assert out["images"] == 0
    assert out["text"] == "Before the plate.\n\nAfter."


def test_fetch_page_caps_the_number_of_images(st, monkeypatch):
    imgs = "".join('<img src="/p%d.png">' % i for i in range(mcp_tools.MAX_IMAGES + 5))
    html = "<body><article><p>Text.</p>%s</article></body>" % imgs
    monkeypatch.setattr(mcp_tools, "fetch_html", lambda url: (html, url))
    seen = []
    def fetch(url):
        seen.append(url)
        return {"id": "%040d" % len(seen), "w": 1, "h": 1}
    monkeypatch.setattr(st.images, "fetch", fetch)
    out = mcp_tools.fetch_page(st, "https://example.com/ch1")
    assert out["images"] == mcp_tools.MAX_IMAGES
    assert len(seen) == mcp_tools.MAX_IMAGES
    assert "@@IMG" not in out["text"]


def test_fetch_page_truncates_a_huge_page(st, monkeypatch):
    monkeypatch.setattr(mcp_tools, "MAX_TEXT_CHARS", 100)
    html = "<body><article>%s</article></body>" % "".join("<p>%s</p>" % ("z" * 40) for _ in range(20))
    monkeypatch.setattr(mcp_tools, "fetch_html", lambda url: (html, url))
    out = mcp_tools.fetch_page(st, "https://example.com/ch1")
    assert out["truncated"] is True
    assert len(out["text"]) <= 100


def test_fetch_page_propagates_a_fetch_failure(st, monkeypatch):
    from webpage import PageError
    def boom(url):
        raise PageError("download failed: nope")
    monkeypatch.setattr(mcp_tools, "fetch_html", boom)
    with pytest.raises(PageError, match="download failed"):
        mcp_tools.fetch_page(st, "https://example.com/ch1")
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `.venv/bin/pytest tests/test_mcp_tools.py -q`
Expected: collection error — `ModuleNotFoundError: No module named 'mcp_tools'`.

- [ ] **Step 3: Write `mcp_tools.py`**

```python
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
        placeholder = IMG_PLACEHOLDER(n)
        marker = ""
        if imported < MAX_IMAGES:
            try:
                marker = "[img:%s]" % st.images.fetch(url)["id"]
                imported += 1
            except (ImageError, OSError) as exc:
                log.info("skipping image %s: %s", url, exc)
        text = text.replace(placeholder, marker)
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

    positions is keyed by doc_id and doc_id is a hash of the text, so an append
    mints a new key: without carrying the old position over first, load_doc
    would hand the worker position 0 and the reader would jump to the top.
    """
    text = _require_text(text)
    with st.lock:
        base = st.text.strip()
        combined = f"{base}\n\n{text}" if base else text
        pos = st.state["positions"].get(st.doc_id)
        if pos:
            st.state["positions"][_doc_id(combined)] = pos
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
```

- [ ] **Step 4: Run the tests until they pass**

Run: `.venv/bin/pytest tests/test_mcp_tools.py -q`
Expected: all pass. Note `tests/test_server.py` has no `__init__.py` alongside it — if `from tests.test_server import FakeWorker` fails to import, check `pytest.ini` for `rootdir`/`pythonpath` and import as `from test_server import ...` instead, matching however the existing suite resolves it.

- [ ] **Step 5: Run the fast suite**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add mcp_tools.py tests/test_mcp_tools.py
git commit -m "feat: MCP tool bodies for fetching, loading and appending chapter text"
```

---

### Task 3: MCP server wiring and the `/mcp` route

**Files:**
- Create: `mcp_app.py`
- Create: `tests/test_mcp_endpoint.py`
- Modify: `server.py` (imports, `create_app` lifespan, end of `create_app`)

**Interfaces:**
- Consumes: `mcp_tools.fetch_page/load_text/append_text/get_status`; `AppState`.
- Produces: `mcp_app.build_mcp(st) -> MCPServer`; `server.create_app(...)` now serves `POST /mcp`.

- [ ] **Step 1: Write `mcp_app.py`**

The tool descriptions are the agent's only instructions — the `[img:…]` and
one-paragraph-per-line contract lives there, not in a comment.

```python
"""MCP server definition — the protocol face of mcp_tools.

Kept separate so that everything in mcp_tools stays importable (and testable)
without the `mcp` package installed.
"""
from mcp.server.mcpserver import MCPServer

import mcp_tools

INSTRUCTIONS = """Read a web page aloud in the user's TTS reader.

Normal flow: call fetch_page(url), translate the text yourself, then call
load_text with your translation. The reader picks it up within a couple of
seconds — the user does not need to reload anything."""

FETCH_DESC = """Download a web page and return its chapter text, with page
furniture (nav, ads, footers) removed and illustrations imported.

Returns title, url, text, chars, paragraphs, images, truncated. Changes nothing
in the reader — call load_text when your translation is ready.

The text uses ONE PARAGRAPH PER LINE. When you translate it, keep that shape,
and copy any [img:...] lines through verbatim and in place — they are the
illustrations, and moving or dropping one moves the picture in the reader."""

LOAD_DESC = """Replace the reader's document with this text and start generating
audio for it. One paragraph per line; [img:<40 hex chars>] lines on their own
render as illustrations. Use this for the translation of a page you fetched."""

APPEND_DESC = """Append text to the end of the current document, keeping the
listener's position and playback intact. Use this to add the next page of a
chapter you are translating a piece at a time."""

STATUS_DESC = """What the reader is doing right now: document id, chunk count,
current position and the sentence at it, engine, voice, device mode, how many
chunks have audio ready or failed, and why generation is blocked if it is."""


def build_mcp(st) -> MCPServer:
    """An MCPServer whose tools drive the given AppState.

    Tool bodies are sync on purpose: the SDK dispatches them on a worker thread,
    so the blocking work (download, chunking, worker handoff) stays off the
    event loop — the same deal FastAPI gives the sync endpoints in server.py.
    """
    server = MCPServer("novel-tts", instructions=INSTRUCTIONS)

    @server.tool(description=FETCH_DESC)
    def fetch_page(url: str) -> dict:
        return mcp_tools.fetch_page(st, url)

    @server.tool(description=LOAD_DESC)
    def load_text(text: str) -> dict:
        return mcp_tools.load_text(st, text)

    @server.tool(description=APPEND_DESC)
    def append_text(text: str) -> dict:
        return mcp_tools.append_text(st, text)

    @server.tool(description=STATUS_DESC)
    def get_status() -> dict:
        return mcp_tools.get_status(st)

    return server
```

- [ ] **Step 2: Wire it into `server.py`**

Add `import contextlib` to the imports at the top.

Replace the `lifespan` definition (currently `server.py:186-190`) and add the mount.
Insert **before** `app = FastAPI(lifespan=lifespan)` — the MCP app must exist before
the lifespan runs, because `session_manager` raises if `streamable_http_app()` has not
been called yet:

```python
    def _build_mcp():
        """The MCP connector, or None when the `mcp` package isn't installed."""
        try:
            from mcp_app import build_mcp
        except ImportError:
            log.warning("mcp package not installed - /mcp connector disabled")
            return None
        return build_mcp(st)

    mcp_server = _build_mcp()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(_poll_file())
        async with contextlib.AsyncExitStack() as stack:
            if mcp_server is not None:
                await stack.enter_async_context(mcp_server.session_manager.run())
            yield
        task.cancel()
```

Then at the end of `create_app`, just before `return app`:

```python
    if mcp_server is not None:
        # Copy the route rather than app.mount(): a mounted sub-app answers
        # POST /mcp with a 307 to /mcp/, and a redirect mid-handshake is exactly
        # what an MCP client handles worst.
        sub = mcp_server.streamable_http_app(
            streamable_http_path="/mcp", json_response=True, stateless_http=True)
        app.router.routes.extend(sub.routes)
```

Note the ordering constraint inside `create_app`: `_poll_file` and `_check_reload` are
defined above the lifespan already, so the new block goes between `_poll_file` and
`app = FastAPI(...)`.

- [ ] **Step 3: Write the endpoint test**

Create `tests/test_mcp_endpoint.py`:

```python
import json

import pytest

pytest.importorskip("mcp")

import httpx

from server import create_app
from tests.test_server import FakeManager, FakeWorker

HEADERS = {"content-type": "application/json",
           "accept": "application/json, text/event-stream"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "test", "version": "1"}}}


def rpc(method, params=None, id=1):
    return {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}


@pytest.fixture
def app(tmp_path):
    (tmp_path / "novel.txt").write_text("First line.\n\nSecond line.")
    return create_app(tmp_path, FakeWorker(tmp_path / "cache"), manager=FakeManager())


@pytest.mark.anyio
async def test_initialize_list_tools_and_load_text(app):
    transport = httpx.ASGITransport(app=app)
    # The SDK auto-enables DNS-rebinding protection for 127.0.0.1, so the Host
    # header needs a port to match its "127.0.0.1:*" allowlist.
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            r = await c.post("/mcp", json=INIT, headers=HEADERS)
            assert r.status_code == 200

            r = await c.post("/mcp", json=rpc("tools/list", id=2), headers=HEADERS)
            names = {t["name"] for t in r.json()["result"]["tools"]}
            assert names == {"fetch_page", "load_text", "append_text", "get_status"}

            r = await c.post("/mcp", json=rpc(
                "tools/call", {"name": "load_text", "arguments": {"text": "Hello there."}}, id=3),
                headers=HEADERS)
            result = r.json()["result"]
            assert result.get("isError") is not True
            payload = json.loads(result["content"][0]["text"])
            assert payload["chunks"] == 1

            r = await c.post("/mcp", json=rpc(
                "tools/call", {"name": "get_status", "arguments": {}}, id=4), headers=HEADERS)
            payload = json.loads(r.json()["result"]["content"][0]["text"])
            assert payload["chunks"] == 1
            assert payload["current_text"] == "Hello there."


@pytest.mark.anyio
async def test_a_failing_tool_comes_back_as_a_tool_error(app):
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as c:
            await c.post("/mcp", json=INIT, headers=HEADERS)
            r = await c.post("/mcp", json=rpc(
                "tools/call", {"name": "fetch_page", "arguments": {"url": "file:///etc/passwd"}},
                id=2), headers=HEADERS)
            result = r.json()["result"]
            assert result["isError"] is True
            assert "http" in result["content"][0]["text"]


def test_existing_api_still_works(app):
    from fastapi.testclient import TestClient
    with TestClient(app) as client:
        assert client.get("/api/doc").status_code == 200
```

If `pytest.mark.anyio` is not configured in this repo, add to `tests/test_mcp_endpoint.py`:

```python
@pytest.fixture
def anyio_backend():
    return "asyncio"
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/pytest tests/test_mcp_endpoint.py -q`
Expected: pass. A 307 means the route was mounted instead of copied; a `RuntimeError`
about the session manager means `streamable_http_app()` runs after the lifespan starts.

- [ ] **Step 5: Run the fast suite**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: all pass, including the existing `tests/test_server.py`.

- [ ] **Step 6: Verify the guarded import**

Run:

```bash
.venv/bin/python -c "
import builtins, sys
real = builtins.__import__
def fake(name, *a, **k):
    if name.startswith('mcp'): raise ImportError('no mcp')
    return real(name, *a, **k)
builtins.__import__ = fake
sys.argv = ['x']
from pathlib import Path
import tempfile
from server import create_app
sys.path.insert(0, 'tests')
from test_server import FakeWorker, FakeManager
d = Path(tempfile.mkdtemp())
app = create_app(d, FakeWorker(d / 'cache'), manager=FakeManager())
print('booted without mcp:', [r.path for r in app.router.routes if hasattr(r, 'path')][:4])
"
```

Expected: prints the route list and no traceback.

- [ ] **Step 7: Commit**

```bash
git add mcp_app.py tests/test_mcp_endpoint.py server.py
git commit -m "feat: serve the novel-tts MCP connector at /mcp"
```

---

### Task 4: Keep playback alive across an append

**Files:**
- Modify: `frontend/src/lib/player.ts:141-160` (`pollStatus`)
- Modify: `static/` (rebuilt output, committed)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of the Python side).
- Produces: no new exports.

- [ ] **Step 1: Change `pollStatus`**

Replace the `if (s.doc_id !== this.doc.doc_id) { ... }` branch:

```ts
      if (s.doc_id !== this.doc.doc_id) {
        // An agent appending a page mints a new doc_id, but the chunk being
        // spoken survives with the same id (and the same audio URL) — so
        // re-index and keep playing instead of stopping mid-sentence.
        const keepCid = this.playing ? this.doc.chunks[this.idx]?.id : undefined
        await this.loadDoc()
        const kept = keepCid ? this.doc.chunks.findIndex((c) => c.id === keepCid) : -1
        if (kept >= 0) {
          this.idx = kept
          this.playing = true
          this.emit()
        } else {
          this.audio.pause()
          this.playing = false
          this.emit()
        }
      } else {
```

- [ ] **Step 2: Type-check and lint**

Run:

```bash
export PATH=~/node22/bin:$PATH
cd frontend && npx tsc --noEmit && npx oxlint src/lib/player.ts
```

Expected: no errors.

- [ ] **Step 3: Build**

Run:

```bash
export PATH=~/node22/bin:$PATH
cd frontend && npm run build
```

Expected: writes into `../static`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/player.ts static
git commit -m "fix: keep playing when an agent appends to the document"
```

---

### Task 5: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the connector**

Add to `README.md`, after the "Qwen3-TTS extras" section:

```markdown
## MCP connector (translate a website into the reader)

With the server running, an AI agent can fetch a page, translate it, and load the
translation for the TTS to read:

    claude mcp add --transport http novel-tts http://localhost:8765/mcp

Tools: `fetch_page(url)` (returns the page's chapter text — nav and ads stripped,
illustrations imported), `load_text(text)` (replaces the document), `append_text(text)`
(adds the next page, keeping your place and playback), `get_status()`.

The agent does the translating — no API key, nothing sent anywhere by the server.
A load appears in the open browser within a couple of seconds.
```

- [ ] **Step 2: Full fast suite**

Run: `.venv/bin/pytest -m "not slow" -q`
Expected: all pass.

- [ ] **Step 3: Live smoke test against the real server**

Run in one shell:

```bash
.venv311/bin/python server.py
```

In another:

```bash
.venv/bin/python - <<'EOF'
import asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async def main():
    async with streamable_http_client("http://localhost:8765/mcp") as (r, w, *_):
        async with ClientSession(r, w) as s:
            await s.initialize()
            print([t.name for t in (await s.list_tools()).tools])
            out = await s.call_tool("load_text", {"text": "The connector works."})
            print(out.content[0].text)
            print((await s.call_tool("get_status", {})).content[0].text)
asyncio.run(main())
EOF
```

Expected: the four tool names, a summary with `chunks: 1`, and a status showing
`current_text: "The connector works."`. The open browser tab should show the new text
within a couple of seconds. Stop the server afterwards.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: MCP connector usage"
```

---

## Self-Review

**Spec coverage:** streamable-HTTP endpoint on the existing app (Task 3) · agent does the translating, no server-side LLM (whole design; no translation code anywhere) · `fetch_page` caps, extraction, image import, marker contract (Tasks 1–2) · load equals a paste (Task 2) · append keeps position (Task 2) and playback (Task 4) · boots without `mcp` (Task 3 Step 6) · fast suite green without torch (every task's last-but-one step) · tests named in the spec map to Tasks 1, 2 and 3 · deps recorded (Task 1) · README (Task 5).

**Types:** `PageContent(title, text, image_urls)`, `IMG_PLACEHOLDER(n)`, `fetch_html -> (html, final_url)`, `PageError` are defined in Task 1 and used with the same names and shapes in Tasks 2 and 3. `st.images.fetch(url) -> {"id": ...}` matches `images.ImageStore.fetch`. `worker.status()` keys (`ready`, `failed`, `blocked`) match `tests/test_server.py:FakeWorker` and `tts/worker.py`. `manager.info()` keys (`engine`, `mode`) match `tts/manager.py`.
