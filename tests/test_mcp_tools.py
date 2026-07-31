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
    assert st.novel_path.read_text().strip() == "Brand new chapter."


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


def test_append_text_clamps_a_stale_out_of_range_position(st):
    st.state["positions"][st.doc_id] = 99          # left over from a longer document
    out = mcp_tools.append_text(st, "Third line.")
    assert out["position"] == out["chunks"] - 1 == 2


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
    html = ("<html><head><title>Ch 1</title></head><body><article><p>%s</p></article>"
            "</body></html>" % ("word " * 60))
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
    html = "<body><article>%s</article></body>" % "".join(
        "<p>%s</p>" % ("z" * 40) for _ in range(20))
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
