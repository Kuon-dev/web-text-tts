"""Split pasted novel text into TTS-sized chunks with stable ids."""
import hashlib
import re
from dataclasses import dataclass

MAX_CHUNK_CHARS = 400

# Split on whitespace after sentence-end punctuation (optionally followed by a
# closing quote). Lookbehind-only so re.split consumes ONLY whitespace — the
# quote stays attached to its sentence and no characters are lost.
_SENTENCE_END = re.compile('(?:(?<=[.!?…])|(?<=[.!?…][""' + "''" + ']))\\s+')


@dataclass(frozen=True)
class Chunk:
    text: str
    para: int


def split_paragraphs(text: str) -> list[str]:
    """Each non-empty line is a paragraph (matches copy-paste from web readers)."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return [re.sub(r"\s+", " ", line).strip() for line in text.split("\n") if line.strip()]


def _split_sentences(para: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_END.split(para) if s.strip()]


def _hard_split(sentence: str, max_chars: int) -> list[str]:
    parts = []
    while len(sentence) > max_chars:
        cut = sentence.rfind(" ", 0, max_chars + 1)
        if cut <= 0:
            cut = max_chars
        parts.append(sentence[:cut].strip())
        sentence = sentence[cut:].strip()
    if sentence:
        parts.append(sentence)
    return parts


def _group_sentences(sentences: list[str], max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    groups: list[str] = []
    current = ""
    for sentence in sentences:
        pieces = _hard_split(sentence, max_chars) if len(sentence) > max_chars else [sentence]
        for piece in pieces:
            if not current:
                current = piece
            elif len(current) + 1 + len(piece) <= max_chars:
                current = current + " " + piece
            else:
                groups.append(current)
                current = piece
    if current:
        groups.append(current)
    return groups


def chunk_text(text: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    for para_idx, para in enumerate(split_paragraphs(text)):
        for group in _group_sentences(_split_sentences(para)):
            chunks.append(Chunk(text=group, para=para_idx))
    return chunks


def doc_id(text: str) -> str:
    normalized = "\n".join(split_paragraphs(text))
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def chunk_id(voice: str, text: str) -> str:
    return hashlib.sha1((voice + "\x00" + text).encode("utf-8")).hexdigest()
