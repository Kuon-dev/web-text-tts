from chunker import MAX_CHUNK_CHARS, Chunk, chunk_id, chunk_text, doc_id, split_paragraphs


def test_split_paragraphs_one_per_line():
    text = "First para.\nSecond para.\n\n\nThird para.\n"
    assert split_paragraphs(text) == ["First para.", "Second para.", "Third para."]


def test_split_paragraphs_strips_bom_crlf_and_inner_whitespace():
    text = "﻿Hello   world.\r\nNext\tline.\r\n"
    assert split_paragraphs(text) == ["Hello world.", "Next line."]


def test_chunk_text_short_paragraph_is_one_chunk():
    chunks = chunk_text("A tiny paragraph. It has two sentences.")
    assert chunks == [Chunk(text="A tiny paragraph. It has two sentences.", para=0)]


def test_chunk_text_para_indexes():
    chunks = chunk_text("Para one.\nPara two.")
    assert [c.para for c in chunks] == [0, 1]


def test_chunk_text_groups_sentences_under_limit():
    sent = "This sentence is about sixty characters long, give or take. "
    para = (sent * 10).strip()  # ~600 chars -> must split
    chunks = chunk_text(para)
    assert len(chunks) >= 2
    assert all(len(c.text) <= MAX_CHUNK_CHARS for c in chunks)
    # nothing lost: rejoined text equals original modulo spacing
    assert " ".join(c.text for c in chunks) == para


def test_chunk_text_hard_splits_single_giant_sentence():
    para = "word " * 200  # ~1000 chars, no sentence punctuation
    chunks = chunk_text(para.strip())
    assert all(len(c.text) <= MAX_CHUNK_CHARS for c in chunks)
    assert " ".join(c.text for c in chunks) == para.strip()


def test_doc_id_stable_across_whitespace_noise():
    assert doc_id("Hello.\nWorld.") == doc_id("﻿Hello.\r\n\r\nWorld.\r\n")
    assert doc_id("Hello.") != doc_id("Goodbye.")


def test_chunk_id_depends_on_voice_and_text():
    assert chunk_id("af_heart", "Hi.") != chunk_id("am_adam", "Hi.")
    assert chunk_id("af_heart", "Hi.") != chunk_id("af_heart", "Yo.")
    assert chunk_id("af_heart", "Hi.") == chunk_id("af_heart", "Hi.")


def test_quoted_dialogue_not_mangled():
    sent = '"We move at dawn." The captain nodded slowly toward the distant gate. '
    para = (sent * 8).strip()  # ~570 chars -> forces a split across quoted sentences
    chunks = chunk_text(para)
    assert " ".join(c.text for c in chunks) == para  # no characters lost at split points
    assert all(len(c.text) <= MAX_CHUNK_CHARS for c in chunks)
