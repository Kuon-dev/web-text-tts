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
