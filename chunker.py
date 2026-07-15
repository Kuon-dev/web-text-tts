"""Split pasted novel text into TTS-sized chunks with stable ids."""
import hashlib
import re
from dataclasses import dataclass

# A chunk is the unit of time-to-first-audio: the player can't start speaking
# a chunk until its whole WAV exists, so under GPU contention (a game running)
# the worst-case stall is the chunk's full audio length. 250 keeps that under
# ~16s while still exceeding the longest real sentence observed (~246 chars),
# so sentences are never hard-split mid-flow.
MAX_CHUNK_CHARS = 250

# An illustration reference on its own line: [img:<sha1 of image bytes>].
# Marker paragraphs are never sent to TTS; the reader renders them inline.
IMG_MARKER = re.compile(r"^\[img:([0-9a-f]{40})\]$")

# Split on whitespace after sentence-end punctuation (optionally followed by a
# closing quote). Lookbehind-only so re.split consumes ONLY whitespace — the
# quote stays attached to its sentence and no characters are lost.
_SENTENCE_END = re.compile(r'(?:(?<=[.!?…])|(?<=[.!?…]["”’\']))\s+')


@dataclass(frozen=True)
class Chunk:
    text: str
    para: int


@dataclass(frozen=True)
class ImageRef:
    id: str
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
        if IMG_MARKER.match(para):
            continue
        for group in _group_sentences(_split_sentences(para)):
            chunks.append(Chunk(text=group, para=para_idx))
    return chunks


def doc_images(text: str) -> list[ImageRef]:
    """Image markers with the paragraph index they occupy in the document."""
    refs: list[ImageRef] = []
    for para_idx, para in enumerate(split_paragraphs(text)):
        m = IMG_MARKER.match(para)
        if m:
            refs.append(ImageRef(id=m.group(1), para=para_idx))
    return refs


def doc_id(text: str) -> str:
    normalized = "\n".join(split_paragraphs(text))
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


# Bumped whenever pronunciation rules change, so cached WAVs synthesized
# under the old rules stop being served and regenerate (LRU evicts the
# orphans). v2: romaji-aware G2P fallback for Japanese names.
PRONUNCIATION_V = "2"


def chunk_id(voice: str, text: str) -> str:
    return hashlib.sha1(
        (PRONUNCIATION_V + "\x00" + voice + "\x00" + text).encode("utf-8")
    ).hexdigest()
