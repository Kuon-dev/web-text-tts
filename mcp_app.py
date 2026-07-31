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
