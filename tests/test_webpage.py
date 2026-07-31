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
