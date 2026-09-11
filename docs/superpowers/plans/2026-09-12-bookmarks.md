# Bookmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marks inside a chapter — `b` marks the sentence being read, `n`/`⇧N` step between marks, `⇧B` lists them in the command palette, and marked lines show a bar in the reader and a tick on the dock's progress rail.

**Architecture:** Marks live server-side in `state.json` as `bookmarks[doc_id] = [{chunk, excerpt}]`, a sibling of the existing `positions` map, and reach the client on the `/api/doc` fetch it already makes. One idempotent whole-list route (`PUT /api/bookmarks`) replaces a document's marks. All client logic that is worth asserting is a pure export in `frontend/src/lib/bookmarks.ts`, because vitest here runs in `environment: "node"` with no DOM and cannot test components.

**Tech Stack:** Python 3 / FastAPI / pydantic v2 / pytest on the server; React 19 + TypeScript + Tailwind v4 + shadcn/ui + motion, built by Vite into `../static`, tested with vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-bookmarks-design.md`

## Global Constraints

- **Reader hot path.** `Reader.tsx` renders ~10k sentence spans and re-renders all of them on every 2s status poll and twice per sentence advance. A per-sentence bookmark indicator must be an O(1) `Set.has` producing one class token — never an array `.some()` inside the map, a per-span motion component, or a per-sentence observer.
- **The dock must never change height.** Transient messages are sonner toasts with stable id constants, never inline chrome. `--dock-h` is measured once by a `ResizeObserver`.
- **No new accent hue.** All five `--ac-*` slots are assigned to the dock modules and `--accent-base` is reserved for playback state. Bookmark visuals use `--foreground` at reduced opacity.
- **Validate and clamp on read AND on write.** Trust neither `state.json` nor the request body, the way `position()` clamps at `server.py:145` and `post_state` clamps the same value again at `server.py:338`.
- **Every mutation of `st.state`** happens `with st.lock:` and ends with `st.save_state()`.
- **Bindings are declared exactly once**, in the `ACTIONS` table in `lib/keymap.ts`. The ⌘K palette and the `?` sheet both generate themselves from it — a hand-written key handler or a hand-written help row is against the grain.
- **Comments explain WHY, at length, at the point of the decision**, and name the concrete bug or measured regression they prevent. A new module without that register reads as foreign.
- **Caps:** `MAX_MARKS = 200` per document, `MAX_BOOKMARK_DOCS = 20` documents.
- **Commit style:** `feat(bookmarks): …`, `fix(mcp): …`, `docs: …`, and a final separate `build: ship …` for the rebuilt bundle.
- **Commands:**
  - Python: `.venv/bin/pytest -m "not slow"` (single file: `.venv/bin/pytest tests/test_server.py -v`)
  - Frontend: `export PATH=~/node22/bin:$PATH` then `npm test -w frontend`, `npm run build -w frontend`

## Deviations from the spec

Three refinements found while writing the plan. All are deliberate; the spec is otherwise implemented as written.

1. **`PlayerSnapshot` carries two fields, not one.** The spec says `bookmarks: ReadonlySet<number>`. The palette page needs the excerpts, and the reader needs an O(1) probe, so the snapshot carries both `bookmarks: readonly Mark[]` (source of truth) and `bookmarkSet: ReadonlySet<number>` (precomputed for the span loop). They are maintained together in the engine, so neither is derived per render.
2. **No `jumpToBookmark(i)` method.** The spec lists it as a fourth player method, but it would be a pure alias for `jump(i)`. The palette calls `player.jump(chunk)` directly.
3. **Bookmark writes are immediate, not debounced.** The spec says writes go out "debounced and `keepalive: true`, the way `savePosition` does". A toggle is a discrete action, not a stream like a moving position, so a debounce would only add a window in which the mark can be lost. The PUT is whole-list and idempotent, so repeated presses converge correctly. `keepalive: true` is kept.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `frontend/src/lib/bookmarks.ts` | The mark type and all pure list logic: toggle, next/prev, staleness filter, index set. No imports, no React, no DOM. |
| `frontend/src/lib/bookmarks.test.ts` | vitest for the above. |

**Modified**

| File | Change |
|---|---|
| `server.py` | `DEFAULT_STATE`, the per-instance nested copy, the loader guard, `bookmarks()` / `set_bookmarks()`, `doc_json()`, `BookmarksBody`, `PUT /api/bookmarks` |
| `mcp_tools.py` | carry marks across an append; fix the `if pos:` truthiness bug |
| `tests/test_server.py` | route, clamping, persistence, prune tests |
| `tests/test_mcp_tools.py` | append-carry tests |
| `frontend/src/lib/api.ts` | `Doc.bookmarks` |
| `frontend/src/lib/player.ts` | snapshot fields, three methods, `loadDoc` wiring, the PUT |
| `frontend/src/lib/keymap.ts` | `Group` gains `"Bookmarks"`, `KeymapCtx.openPalettePage` widens, four `ACTIONS` rows |
| `frontend/src/lib/keymap.test.ts` | widen the player mock, update the paired-actions pin |
| `frontend/src/components/CommandPalette.tsx` | `PalettePage` widens, a third page |
| `frontend/src/components/Reader.tsx` | one class token on the sentence span |
| `frontend/src/components/dock/Dock.tsx` | ticks on the rail, snap-to-mark scrub |
| `frontend/src/index.css` | `.rd-marked::before` |
| `README.md` | the new keys and what a bookmark is |

**`App.tsx` needs no edit.** Its `palettePage` state is already `useState<PalettePage | null>(null)` (`App.tsx:58`) and its `openPalettePage` parameter is inferred from `KeymapCtx`, so widening both unions flows through automatically. Verify with `tsc -b`; do not add a cast.

---

### Task 1: Server-side bookmark storage

`AppState` learns to hold, clamp and replace a document's marks. No HTTP yet.

**Files:**
- Modify: `server.py:30` (DEFAULT_STATE), `server.py:99` (per-instance copy), `server.py:106` (loader guards), after `server.py:146` (accessors)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_MARKS: int = 200`, `MAX_BOOKMARK_DOCS: int = 20` (module scope in `server.py`)
  - `AppState.bookmarks() -> list[dict]` — the current document's marks, each `{"chunk": int, "excerpt": str}`, sorted by `chunk`, with out-of-range entries dropped. Returns the **stored** excerpt, not a freshly derived one.
  - `AppState.set_bookmarks(chunks: list[int]) -> list[dict]` — replace the current document's marks; returns what was stored. Does **not** call `save_state()`; the caller does, under the lock it already holds.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_server.py`, at the end of the file, in that module's flat `def test_<sentence>(tmp_path)` style.

`create_app` keeps its `AppState` as a closure local (`server.py:196`) and does **not** put it on `app.state`, so these tests build one directly — the same way `tests/test_mcp_tools.py:11` does. Extend the existing import at the top of the module to `from server import STATIC_DIR, AppState, MAX_BOOKMARK_DOCS, create_app, migrate_state`, and add this helper beside `make_app`:

```python
def make_state(tmp_path):
    """An AppState with no app around it: create_app keeps its state as a
    closure local, and these tests exercise the state directly."""
    return AppState(tmp_path, FakeWorker(tmp_path / "cache"), FakeManager())
```

```python
def test_set_bookmarks_sorts_dedupes_and_drops_out_of_range(tmp_path):
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.\nThree.")
    stored = st.set_bookmarks([2, 0, 2, 99, -1])
    assert [m["chunk"] for m in stored] == [0, 2]
    assert stored[0]["excerpt"] == "One."
    assert stored[1]["excerpt"] == "Three."


def test_bookmarks_accessor_drops_indices_past_the_end(tmp_path):
    # A mark stored against a longer version of the document must never read
    # back as "the last sentence" the way a position does - a mis-aimed
    # bookmark is worse than an absent one.
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.\nThree.")
    st.set_bookmarks([0, 2])
    st.load_doc("One.")
    assert [m["chunk"] for m in st.bookmarks()] == [0]


def test_bookmarks_keep_their_stored_excerpt(tmp_path):
    # The excerpt is what a later re-anchoring pass would match on, so it is
    # stored, not re-derived: re-deriving it would silently make every mark
    # agree with whatever text now sits at that index.
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    st.set_bookmarks([1])
    st.state["bookmarks"][st.doc_id][0]["excerpt"] = "Something else."
    assert st.bookmarks()[0]["excerpt"] == "Something else."


def test_set_bookmarks_with_an_empty_list_removes_the_entry(tmp_path):
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    st.set_bookmarks([1])
    assert st.doc_id in st.state["bookmarks"]
    assert st.set_bookmarks([]) == []
    assert st.doc_id not in st.state["bookmarks"]


def test_bookmarks_map_prunes_to_the_most_recently_written_docs(tmp_path):
    st = make_state(tmp_path)
    first_id = None
    for n in range(MAX_BOOKMARK_DOCS + 1):
        st.load_doc(f"Chapter {n}.\nSecond line.")
        if n == 0:
            first_id = st.doc_id
        st.set_bookmarks([0])
    assert len(st.state["bookmarks"]) == MAX_BOOKMARK_DOCS
    assert first_id not in st.state["bookmarks"]


def test_rewriting_a_doc_refreshes_its_place_in_the_prune_order(tmp_path):
    # Recency is dict insertion order, not a timestamp - so a write must pop
    # and reinsert, or a document marked long ago and marked again today would
    # still be the first one evicted.
    st = make_state(tmp_path)
    st.load_doc("Chapter 0.\nSecond line.")
    oldest = st.doc_id
    st.set_bookmarks([0])
    for n in range(1, MAX_BOOKMARK_DOCS):
        st.load_doc(f"Chapter {n}.\nSecond line.")
        st.set_bookmarks([0])
    st.load_doc("Chapter 0.\nSecond line.")     # touch the oldest again
    st.set_bookmarks([1])
    st.load_doc("Chapter fresh.\nSecond line.")  # pushes the map over the cap
    st.set_bookmarks([0])
    assert oldest in st.state["bookmarks"]


def test_malformed_bookmarks_in_state_json_fall_back(tmp_path):
    (tmp_path / "state.json").write_text(json.dumps({"bookmarks": "not_a_dict"}))
    st = make_state(tmp_path)
    st.load_doc("One.\nTwo.")
    assert st.bookmarks() == []
    st.set_bookmarks([0])                       # still writable
    assert [m["chunk"] for m in st.bookmarks()] == [0]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/test_server.py -k bookmark -v`
Expected: FAIL — `KeyError: 'bookmarks'` / `AttributeError: 'AppState' object has no attribute 'set_bookmarks'`

- [ ] **Step 3: Add the caps and the state key**

In `server.py`, extend `DEFAULT_STATE` (line 30) with `"bookmarks": {}` and add the caps beside `MAX_PAUSE_MS`:

```python
DEFAULT_STATE = {"positions": {}, "bookmarks": {}, "voices": {"kokoro": "af_heart"}, "speed": 1.0,
                 "volume": 1.0, "pause_ms": 300, "engine": "kokoro", "device_mode": "auto",
                 "instruct": ""}
# Silence the player inserts between chunks (= sentences, see chunker.py).
MAX_PAUSE_MS = 2000
# Bookmarks per document, and documents kept in the bookmarks map. positions is
# never pruned and the live state.json already carries orphaned chapters; this
# map does not inherit that.
MAX_MARKS = 200
MAX_BOOKMARK_DOCS = 20
```

- [ ] **Step 4: Copy the nested dict per instance and guard the loader**

In `AppState.__init__`, line 99 — the existing comment already explains why nested containers are copied; `bookmarks` joins the list it names:

```python
        # dict(DEFAULT_STATE) is a shallow copy: nested containers (positions,
        # bookmarks, voices) must be copied too, or every AppState would share -
        # and mutate - the same module-level dicts.
        self.state = {**DEFAULT_STATE, "positions": {}, "bookmarks": {},
                      "voices": dict(DEFAULT_STATE["voices"])}
```

And in the loader guards, directly after the `positions` guard at line 106:

```python
                if not isinstance(loaded.get("bookmarks"), dict):
                    loaded.pop("bookmarks", None)
```

- [ ] **Step 5: Add the accessors**

In `server.py`, directly after `position()` (which ends at line 146):

```python
    def bookmarks(self) -> list[dict]:
        """The current document's marks, sorted, with anything addressing past
        the end dropped.

        Deliberately unlike position(), which clamps an out-of-range index to
        the last sentence: for a resume point that is a harmless approximation,
        but a bookmark silently pointing at the end of the chapter is worse
        than a bookmark that is gone.

        The stored excerpt is returned as-is rather than re-derived from
        self.chunks. Re-deriving would make every mark agree with whatever text
        now sits at that index, which is precisely the drift the client's
        dropStale exists to catch - and the stored text is what a later
        re-anchoring pass would have to match on.
        """
        raw = self.state["bookmarks"].get(self.doc_id, [])
        if not isinstance(raw, list):
            return []
        out = []
        for m in raw:
            if not isinstance(m, dict):
                continue
            i = m.get("chunk")
            if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(self.chunks):
                continue
            out.append({"chunk": i, "excerpt": str(m.get("excerpt", ""))})
        return sorted(out, key=lambda m: m["chunk"])

    def set_bookmarks(self, chunks: list[int]) -> list[dict]:
        """Replace the current document's marks. Returns what was stored.

        Does not save: every caller already holds st.lock and ends its own
        mutation with st.save_state().
        """
        clean = sorted({i for i in chunks
                        if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(self.chunks)})
        # Over the cap the first MAX_MARKS in chunk order win. This is a
        # backstop against a malformed request, not a UX decision - 200 marks
        # in one chapter is not a real case.
        clean = clean[:MAX_MARKS]
        marks = [{"chunk": i, "excerpt": self.chunks[i].text} for i in clean]
        bm = self.state["bookmarks"]
        # Recency is dict insertion order, not a stored timestamp: popping
        # before reinserting is what moves a document to the end, so a chapter
        # marked again today is not still the first one evicted.
        bm.pop(self.doc_id, None)
        if marks:
            bm[self.doc_id] = marks
        while len(bm) > MAX_BOOKMARK_DOCS:
            bm.pop(next(iter(bm)))
        return marks
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_server.py -k bookmark -v`
Expected: PASS (7 tests)

- [ ] **Step 7: Run the whole fast suite**

Run: `.venv/bin/pytest -m "not slow"`
Expected: PASS, no regressions

- [ ] **Step 8: Commit**

```bash
git add server.py tests/test_server.py
git commit -m "feat(bookmarks): per-document marks in state.json, clamped on read and write"
```

---

### Task 2: `PUT /api/bookmarks` and `doc_json`

The HTTP surface. One idempotent whole-list route, and marks ride the `/api/doc` fetch the client already makes.

**Files:**
- Modify: `server.py:61` (body models), `server.py:163` (`doc_json`), after `server.py:292` (routes)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `AppState.bookmarks()`, `AppState.set_bookmarks()` from Task 1.
- Produces:
  - `PUT /api/bookmarks` — request `{"chunks": [int, …]}`, response `{"bookmarks": [{"chunk": int, "excerpt": str}, …]}`
  - `GET /api/doc` and `POST /api/doc` responses gain `"bookmarks": [{"chunk": int, "excerpt": str}, …]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
def test_put_bookmarks_stores_and_returns_them(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    resp = client.put("/api/bookmarks", json={"chunks": [2, 0]})
    assert resp.status_code == 200
    assert resp.json()["bookmarks"] == [
        {"chunk": 0, "excerpt": "One."},
        {"chunk": 2, "excerpt": "Three."},
    ]


def test_doc_json_carries_bookmarks(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.put("/api/bookmarks", json={"chunks": [1]})
    assert client.get("/api/doc").json()["bookmarks"] == [{"chunk": 1, "excerpt": "Two."}]


def test_put_bookmarks_clamps_out_of_range_indices(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo."})
    body = client.put("/api/bookmarks", json={"chunks": [0, 99999, -3]}).json()
    assert [m["chunk"] for m in body["bookmarks"]] == [0]


def test_put_bookmarks_rejects_a_non_integer_list(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo."})
    assert client.put("/api/bookmarks", json={"chunks": ["nope"]}).status_code == 422


def test_bookmarks_are_per_document(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.put("/api/bookmarks", json={"chunks": [2]})
    client.post("/api/doc", json={"text": "Other chapter."})
    assert client.get("/api/doc").json()["bookmarks"] == []
    body = client.post("/api/doc", json={"text": "One.\nTwo.\nThree."}).json()
    assert [m["chunk"] for m in body["bookmarks"]] == [2]


def test_bookmarks_survive_restart(tmp_path):
    client, _ = make_client(tmp_path)
    client.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    client.put("/api/bookmarks", json={"chunks": [1]})
    # fresh app over the same data_dir = server restart
    client2, _ = make_client(tmp_path)
    client2.post("/api/doc", json={"text": "One.\nTwo.\nThree."})
    assert [m["chunk"] for m in client2.get("/api/doc").json()["bookmarks"]] == [1]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/test_server.py -k "put_bookmarks or doc_json_carries or bookmarks_are_per or bookmarks_survive" -v`
Expected: FAIL — 405 Method Not Allowed on the PUT, `KeyError: 'bookmarks'` on the doc reads

- [ ] **Step 3: Add the request model**

In `server.py`, after `StateBody` (which ends at line 66):

```python
class BookmarksBody(BaseModel):
    chunks: list[int]
```

- [ ] **Step 4: Emit marks from `doc_json`**

In `doc_json` (line 163), beside `"position"`:

```python
            "position": self.position(),
            "bookmarks": self.bookmarks(),
```

- [ ] **Step 5: Add the route**

In `create_app`, directly after `post_doc` (which ends at line 292):

```python
    @app.put("/api/bookmarks")
    def put_bookmarks(body: BookmarksBody):
        """Replace the current document's marks.

        Whole-list and idempotent rather than add + delete: toggling is a set
        operation the client already performs, POST /api/state is patch-shaped
        and cannot express a removal, and a bare chunk index is not an identity
        a DELETE could address. pydantic validates the shape; set_bookmarks
        clamps the range, exactly as post_state clamps a position the accessor
        would clamp again.
        """
        with st.lock:
            marks = st.set_bookmarks(body.chunks)
            st.save_state()
            return {"bookmarks": marks}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_server.py -k bookmark -v`
Expected: PASS (13 tests — Task 1's seven plus these six)

- [ ] **Step 7: Run the whole fast suite**

Run: `.venv/bin/pytest -m "not slow"`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server.py tests/test_server.py
git commit -m "feat(bookmarks): PUT /api/bookmarks, and marks ride the doc fetch"
```

---

### Task 3: Carry marks across an append, and fix the position-zero bug

**Files:**
- Modify: `mcp_tools.py:73-89` (`append_text`)
- Test: `tests/test_mcp_tools.py`

**Interfaces:**
- Consumes: `st.state["bookmarks"]` from Task 1.
- Produces: nothing new — behaviour only.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_mcp_tools.py` (its `st` fixture is defined at the top of that module):

```python
def test_append_text_carries_bookmarks_to_the_new_doc_id(st):
    # An append mints a new doc_id but preserves the chunk prefix, so every
    # stored index stays valid.
    st.set_bookmarks([1])
    mcp_tools.append_text(st, "Third line.")
    assert [m["chunk"] for m in st.bookmarks()] == [1]


def test_append_text_keeps_a_position_of_zero(st):
    # The carry used to be guarded with `if pos:`, which silently dropped a
    # saved position of 0 - and would drop a bookmark on the first sentence.
    st.state["positions"][st.doc_id] = 0
    st.load_doc()
    out = mcp_tools.append_text(st, "Third line.")
    assert out["position"] == 0
    assert st.state["positions"][st.doc_id] == 0


def test_append_text_carries_a_bookmark_on_the_first_sentence(st):
    st.set_bookmarks([0])
    mcp_tools.append_text(st, "Third line.")
    assert [m["chunk"] for m in st.bookmarks()] == [0]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest tests/test_mcp_tools.py -k "carries or zero" -v`
Expected: FAIL — the bookmark assertions return `[]`; `test_append_text_keeps_a_position_of_zero` fails because the new doc_id has no `positions` entry

- [ ] **Step 3: Rewrite the carry**

Replace the body of `append_text` in `mcp_tools.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest tests/test_mcp_tools.py -v`
Expected: PASS, including the pre-existing `test_append_text_preserves_the_listeners_position`

- [ ] **Step 5: Run the whole fast suite**

Run: `.venv/bin/pytest -m "not slow"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add mcp_tools.py tests/test_mcp_tools.py
git commit -m "fix(mcp): carry bookmarks across an append, and stop dropping position 0"
```

---

### Task 4: The pure client module

**Files:**
- Create: `frontend/src/lib/bookmarks.ts`
- Test: `frontend/src/lib/bookmarks.test.ts`

**Interfaces:**
- Consumes: nothing. This module has **no imports** — `dropStale` takes a structural `{ text: string }[]` rather than importing `Chunk`, so `api.ts` can import `Mark` from here without a cycle.
- Produces:
  - `interface Mark { chunk: number; excerpt: string }`
  - `toggle(marks: readonly Mark[], chunk: number, excerpt: string): Mark[]`
  - `nextAfter(marks: readonly Mark[], idx: number): number | null`
  - `prevBefore(marks: readonly Mark[], idx: number): number | null`
  - `dropStale(marks: readonly Mark[], chunks: readonly { text: string }[]): Mark[]`
  - `indexSet(marks: readonly Mark[]): ReadonlySet<number>`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/bookmarks.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { dropStale, indexSet, nextAfter, prevBefore, toggle, type Mark } from "./bookmarks"

const marks: Mark[] = [
  { chunk: 2, excerpt: "Two." },
  { chunk: 5, excerpt: "Five." },
]

describe("toggle", () => {
  it("adds a mark and keeps the list sorted by position", () => {
    expect(toggle(marks, 3, "Three.")).toEqual([
      { chunk: 2, excerpt: "Two." },
      { chunk: 3, excerpt: "Three." },
      { chunk: 5, excerpt: "Five." },
    ])
  })

  it("removes a mark that is already there", () => {
    expect(toggle(marks, 2, "Two.")).toEqual([{ chunk: 5, excerpt: "Five." }])
  })

  it("does not mutate the input", () => {
    toggle(marks, 3, "Three.")
    expect(marks).toHaveLength(2)
  })
})

describe("nextAfter / prevBefore", () => {
  it("finds the neighbouring mark", () => {
    expect(nextAfter(marks, 2)).toBe(5)
    expect(prevBefore(marks, 5)).toBe(2)
  })

  it("wraps at both ends", () => {
    expect(nextAfter(marks, 9)).toBe(2)
    expect(prevBefore(marks, 0)).toBe(5)
  })

  it("lands on a mark from a position between two", () => {
    expect(nextAfter(marks, 3)).toBe(5)
    expect(prevBefore(marks, 3)).toBe(2)
  })

  it("returns null when there is nothing to step to", () => {
    expect(nextAfter([], 0)).toBeNull()
    expect(prevBefore([], 0)).toBeNull()
  })

  it("steps off a mark rather than standing still on it", () => {
    expect(nextAfter(marks, 5)).toBe(2)
    expect(prevBefore(marks, 2)).toBe(5)
  })
})

describe("dropStale", () => {
  const chunks = [{ text: "Zero." }, { text: "One." }, { text: "Two." }]

  it("keeps a mark whose sentence still reads the same", () => {
    expect(dropStale([{ chunk: 2, excerpt: "Two." }], chunks)).toHaveLength(1)
  })

  it("drops a mark whose sentence has drifted", () => {
    expect(dropStale([{ chunk: 2, excerpt: "Something else." }], chunks)).toEqual([])
  })

  it("drops a mark that addresses past the end", () => {
    expect(dropStale([{ chunk: 9, excerpt: "Two." }], chunks)).toEqual([])
  })
})

describe("indexSet", () => {
  it("is the positions, for an O(1) probe per sentence", () => {
    const set = indexSet(marks)
    expect(set.has(2)).toBe(true)
    expect(set.has(3)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/node22/bin:$PATH && npm test -w frontend -- bookmarks`
Expected: FAIL — `Failed to resolve import "./bookmarks"`

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/bookmarks.ts`:

```ts
/**
 * Marks inside a chapter. Pure list logic, deliberately import-free: vitest
 * runs in `environment: "node"` and collects only `.test.ts` files under src,
 * so anything worth asserting has to live outside a component — and taking the
 * chunks structurally rather than importing `Chunk` keeps `api.ts` free to
 * import `Mark` from here without a cycle.
 *
 * Every function below assumes `marks` is sorted by `chunk`. `toggle` keeps it
 * that way and the server returns it sorted, so the invariant holds end to end.
 */

export interface Mark {
  /** Index into the document's flat chunk array — one chunk is one sentence. */
  chunk: number
  /** The sentence as it read when the mark was set. See dropStale. */
  excerpt: string
}

/** Add or remove `chunk`, keeping the list in reading order. */
export function toggle(marks: readonly Mark[], chunk: number, excerpt: string): Mark[] {
  if (marks.some((m) => m.chunk === chunk)) return marks.filter((m) => m.chunk !== chunk)
  return [...marks, { chunk, excerpt }].sort((a, b) => a.chunk - b.chunk)
}

/** The first mark after `idx`, wrapping to the first. null if there are none.
 *  Strictly after, so pressing next while sitting on a mark moves on rather
 *  than appearing dead. */
export function nextAfter(marks: readonly Mark[], idx: number): number | null {
  if (!marks.length) return null
  return (marks.find((m) => m.chunk > idx) ?? marks[0]).chunk
}

/** The last mark before `idx`, wrapping to the last. null if there are none. */
export function prevBefore(marks: readonly Mark[], idx: number): number | null {
  if (!marks.length) return null
  let found: Mark | undefined
  for (const m of marks) {
    if (m.chunk >= idx) break
    found = m
  }
  return (found ?? marks[marks.length - 1]).chunk
}

/**
 * The marks that still address the sentence they were set on.
 *
 * The server drops anything pointing past the end of the document; this is the
 * other half — text drift. It matters because a mark that survives into a
 * document whose text changed would otherwise sit silently on the wrong line,
 * and a wrong bookmark is worse than an absent one. Drifted marks stay in
 * state.json on purpose: their stored text is what a later re-anchoring pass
 * would match on.
 */
export function dropStale(marks: readonly Mark[], chunks: readonly { text: string }[]): Mark[] {
  return marks.filter((m) => chunks[m.chunk]?.text === m.excerpt)
}

/** The positions alone. The reader probes this once per sentence span across a
 *  ~10k-span tree, so it must be a Set, built once per change — never an
 *  array scan inside the render. */
export function indexSet(marks: readonly Mark[]): ReadonlySet<number> {
  return new Set(marks.map((m) => m.chunk))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH=~/node22/bin:$PATH && npm test -w frontend -- bookmarks`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/bookmarks.ts frontend/src/lib/bookmarks.test.ts
git commit -m "feat(bookmarks): pure mark logic — toggle, step, staleness"
```

---

### Task 5: Wire the player

**Files:**
- Modify: `frontend/src/lib/api.ts:13-25` (`Doc`), `frontend/src/lib/player.ts` (`PlayerSnapshot` at 19-39, `buildSnapshot` at 122, `loadDoc` at 168, methods near `jump` at 315, the write near `flushPosition` at 559)

**Interfaces:**
- Consumes: `Mark`, `toggle`, `nextAfter`, `prevBefore`, `dropStale`, `indexSet` from Task 4; `PUT /api/bookmarks` from Task 2.
- Produces:
  - `Doc.bookmarks?: Mark[]`
  - `PlayerSnapshot.bookmarks: readonly Mark[]` and `PlayerSnapshot.bookmarkSet: ReadonlySet<number>`
  - `player.toggleBookmark(): void`, `player.nextBookmark(): void`, `player.prevBookmark(): void`

- [ ] **Step 1: Add the wire type**

In `frontend/src/lib/api.ts`, import the type and extend `Doc`:

```ts
import type { Mark } from "./bookmarks"
```

```ts
export interface Doc {
  doc_id: string
  chunks: Chunk[]
  position: number
  voice: string
  speed: number
  volume?: number
  /** silence the player inserts between chunks (= sentences) */
  pause_ms?: number
  instruct?: string
  images?: ImageRef[]
  bookmarks?: Mark[]
}
```

- [ ] **Step 2: Extend the snapshot**

In `frontend/src/lib/player.ts`, add the import:

```ts
import { dropStale, indexSet, nextAfter, prevBefore, toggle, type Mark } from "./bookmarks"
```

Add to `PlayerSnapshot`, after `instruct`:

```ts
  /** Marks in this chapter, in reading order — the palette lists these. */
  bookmarks: readonly Mark[]
  /** The same marks as positions. Carried separately, and kept in step with
   *  `bookmarks` by the engine, because the reader probes it once per sentence
   *  span across a ~10k-span tree that re-renders on every status poll —
   *  deriving a Set per render there is exactly the cost this avoids. */
  bookmarkSet: ReadonlySet<number>
```

Add the backing fields beside the engine's other state (near `private idx = 0`):

```ts
  private marks: readonly Mark[] = []
  private markSet: ReadonlySet<number> = new Set()
```

And in `buildSnapshot`, after `instruct`:

```ts
      bookmarks: this.marks,
      bookmarkSet: this.markSet,
```

- [ ] **Step 3: Load marks with the document**

In `loadDoc`, after the `this.idx = …` line:

```ts
    this.setMarks(dropStale(this.doc.bookmarks ?? [], this.doc.chunks))
```

- [ ] **Step 4: Add the three methods and the write**

Directly after `clickChunk` (line 315):

```ts
  /** Mark (or unmark) the sentence the voice is on. */
  toggleBookmark() {
    const chunk = this.doc.chunks[this.idx]
    if (!chunk) return
    this.setMarks(toggle(this.marks, this.idx, chunk.text))
    this.emit()
    this.saveBookmarks()
  }

  nextBookmark() {
    const i = nextAfter(this.marks, this.idx)
    if (i !== null) this.jump(i)
  }

  prevBookmark() {
    const i = prevBefore(this.marks, this.idx)
    if (i !== null) this.jump(i)
  }

  private setMarks(marks: readonly Mark[]) {
    this.marks = marks
    this.markSet = indexSet(marks)
  }
```

And beside `flushPosition` (line 559):

```ts
  /** Persist the marks. Not debounced, unlike savePosition: a toggle is a
   *  discrete action rather than a moving value, so a debounce would only add
   *  a window in which the mark can be lost. The request is whole-list and
   *  idempotent, so repeated presses converge. `keepalive` for the same reason
   *  the position save uses it — WKWebView and WebView2 do not reliably run
   *  beforeunload. */
  private saveBookmarks() {
    fetch(apiUrl("/api/bookmarks"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunks: this.marks.map((m) => m.chunk) }),
      keepalive: true,
    }).catch(() => {})
  }
```

- [ ] **Step 5: Typecheck**

Run: `export PATH=~/node22/bin:$PATH && npm run build -w frontend`
Expected: PASS. If `tsc` reports that `Reader.tsx` or `Dock.tsx` do not supply the new snapshot fields, that is expected only in Tasks 8 and 9 — at this point nothing consumes them, so the build must be clean.

- [ ] **Step 6: Run the frontend suite**

Run: `export PATH=~/node22/bin:$PATH && npm test -w frontend`
Expected: PASS — `player.test.ts` constructs snapshots; if it asserts on a whole snapshot object, add `bookmarks: []` and `bookmarkSet: new Set()` to its expectations rather than loosening the assertion.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/player.ts
git commit -m "feat(bookmarks): marks on the player snapshot, persisted on toggle"
```

---

### Task 6: The palette page

**Files:**
- Modify: `frontend/src/components/CommandPalette.tsx:28` (`PalettePage`), `:42-51` (PLACEHOLDER / EMPTY), `:73` (destructure), `:199` (render), `frontend/src/lib/keymap.ts:19` (`KeymapCtx`)

**Interfaces:**
- Consumes: `PlayerSnapshot.bookmarks` from Task 5.
- Produces:
  - `PalettePage` gains `"bookmarks"`
  - `KeymapCtx.openPalettePage: (page: "voice" | "model" | "bookmarks") => void` — Task 7's `bookmark-list` action depends on this widening.

- [ ] **Step 1: Widen both unions**

In `frontend/src/components/CommandPalette.tsx:28`:

```ts
/** The lists that are too long to live as palette rows: they get a page of
 *  their own, reached by a root row or straight from `v` / `e` / `⇧B`. */
export type PalettePage = "voice" | "model" | "bookmarks"
```

In `frontend/src/lib/keymap.ts`, inside `KeymapCtx` (line 19):

```ts
  openPalettePage: (page: "voice" | "model" | "bookmarks") => void
```

- [ ] **Step 2: Add the page's copy**

In `CommandPalette.tsx`, extend the two maps:

```ts
const PLACEHOLDER: Record<string, string> = {
  voice: "Search voices…",
  model: "Search models…",
  bookmarks: "Search bookmarks…",
  root: "Type a command…",
}

const EMPTY: Record<string, string> = {
  voice: "No voice found.",
  model: "No model found.",
  bookmarks: "No bookmarks yet — press b to mark the sentence being read.",
  root: "No command found.",
}
```

- [ ] **Step 3: Read the marks and add the handler**

Extend the destructure at line 73:

```ts
  const { voice, voices, engine, switchingTo, bookmarks } = usePlayer()
```

And beside `selectVoice`:

```ts
  /** A bookmark is a place to read from, so going to one moves the playhead —
   *  the same thing clicking a sentence does. */
  const selectBookmark = (chunk: number) => {
    onOpenChange(false)
    player.jump(chunk)
  }
```

- [ ] **Step 4: Render the page**

In `CommandPalette.tsx`, after the `page === "model"` block (which ends at line 217):

```tsx
            {page === "bookmarks" && (
              <CommandGroup heading="Bookmarks">
                {bookmarks.map((m) => (
                  <CommandItem
                    key={m.chunk}
                    value={`${m.excerpt} ${m.chunk}`}
                    onSelect={() => selectBookmark(m.chunk)}
                  >
                    <span className="min-w-0 flex-1 truncate">{m.excerpt}</span>
                    {/* Sentence number, 1-based like the dock's counter. */}
                    <CommandShortcut>{m.chunk + 1}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
```

- [ ] **Step 5: Typecheck and build**

Run: `export PATH=~/node22/bin:$PATH && npm run build -w frontend`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/CommandPalette.tsx frontend/src/lib/keymap.ts
git commit -m "feat(bookmarks): a palette page that lists marks and jumps to them"
```

---

### Task 7: The keys

**Files:**
- Modify: `frontend/src/lib/keymap.ts:4` (`Group`), end of `ACTIONS` (after the `model` entry, ~line 206)
- Test: `frontend/src/lib/keymap.test.ts:9-18` (mock), `:295` (paired-actions pin), plus new assertions

**Interfaces:**
- Consumes: `player.toggleBookmark/nextBookmark/prevBookmark` from Task 5; the widened `KeymapCtx.openPalettePage` from Task 6.
- Produces: action ids `bookmark-toggle`, `bookmark-prev`, `bookmark-next`, `bookmark-list`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/keymap.test.ts`, first widen the mock at lines 9-18 (without this the new actions throw `TypeError` rather than failing on an assertion):

```ts
vi.mock("./player", () => ({
  player: {
    togglePlay: vi.fn(),
    jump: vi.fn(),
    toggleMute: vi.fn(),
    nudgeVolume: vi.fn(),
    nudgeSpeed: vi.fn(),
    toggleBookmark: vi.fn(),
    nextBookmark: vi.fn(),
    prevBookmark: vi.fn(),
    getSnapshot: vi.fn(() => ({ idx: 3 })),
  },
}))
```

Update the pin at line 295 — it lists paired actions in `ACTIONS` order, and `bookmark-prev` is declared last:

```ts
  it("pairs exactly the four two-key rows", () => {
    expect(ACTIONS.filter((a) => a.pair).map((a) => a.id)).toEqual([
      "prev-sentence", "volume-up", "speed-down", "bookmark-prev",
    ])
  })
```

Then add a new block at the end of the file:

```ts
describe("bookmarks", () => {
  it("binds the bare letters nothing else claims", () => {
    expect(idFor(ev("b"))).toBe("bookmark-toggle")
    expect(idFor(ev("n"))).toBe("bookmark-next")
  })

  it("separates the shifted twins from the bare keys", () => {
    // Letters require shift off (keymap.ts), so ⇧N and ⇧B cannot be shadowed
    // by their bare siblings the way a shifted arrow would be.
    expect(idFor(ev("N", { shiftKey: true }))).toBe("bookmark-prev")
    expect(idFor(ev("B", { shiftKey: true }))).toBe("bookmark-list")
  })

  it("stands down while a chapter is being pasted", () => {
    const typing: KeymapGuards = { textEntry: true, controlFocused: false, overlayOpen: false }
    expect(idFor(ev("b"), typing)).toBeNull()
    expect(idFor(ev("n"), typing)).toBeNull()
  })

  it("drives the player and opens its palette page", () => {
    const ctx: KeymapCtx = {
      openPalette: vi.fn(),
      openPalettePage: vi.fn(),
      openHelp: vi.fn(),
      openPaste: vi.fn(),
      toggleSettings: vi.fn(),
    }
    actionById("bookmark-toggle").run(ctx)
    expect(player.toggleBookmark).toHaveBeenCalledOnce()

    actionById("bookmark-next").run(ctx)
    expect(player.nextBookmark).toHaveBeenCalledOnce()

    actionById("bookmark-prev").run(ctx)
    expect(player.prevBookmark).toHaveBeenCalledOnce()

    actionById("bookmark-list").run(ctx)
    expect(ctx.openPalettePage).toHaveBeenCalledWith("bookmarks")
  })

  it("claims no key another action already had", () => {
    // No test asserted this before, and a duplicate binding fails silently —
    // shadowed by whichever action is declared first.
    const seen = new Set<string>()
    for (const a of ACTIONS) {
      for (const s of a.keys) {
        const id = `${s.mod ? "mod+" : ""}${s.shift ? "shift+" : ""}${s.key}`
        expect(seen.has(id), `${id} is bound twice`).toBe(false)
        seen.add(id)
      }
    }
  })
})
```

If the file has an `afterEach(() => vi.clearAllMocks())` at the top, the `toHaveBeenCalledOnce` assertions above are safe as written; if not, add `vi.clearAllMocks()` at the start of the "drives the player" test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/node22/bin:$PATH && npm test -w frontend -- keymap`
Expected: FAIL — `idFor(ev("b"))` is `null`; `no action bookmark-toggle`

- [ ] **Step 3: Add the group**

In `frontend/src/lib/keymap.ts:4`:

```ts
export type Group = "Playback" | "Audio" | "Narration" | "Bookmarks" | "App"
```

- [ ] **Step 4: Add the four actions**

At the end of the `ACTIONS` array in `keymap.ts`, after the `model` entry. Declaration order sets both group order in the two UIs and match precedence, so these go last: none of the four keys is claimed elsewhere, so nothing shadows and nothing is shadowed.

```ts
  {
    // A bookmark marks the sentence the voice is on, not the one nearest the
    // middle of the viewport: `b` is pressed because of something just heard.
    id: "bookmark-toggle",
    label: "Toggle bookmark",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "b" }],
    run: () => player.toggleBookmark(),
  },
  {
    // Declared before its sibling: `pair` is set on the first half only, or
    // the sheet renders the row twice and swallows the wrong partner.
    id: "bookmark-prev",
    label: "Previous bookmark",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "N", shift: true }],
    pair: { with: "bookmark-next", label: "Previous / next bookmark" },
    run: () => player.prevBookmark(),
  },
  {
    id: "bookmark-next",
    label: "Next bookmark",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "n" }],
    run: () => player.nextBookmark(),
  },
  {
    // "reader", matching `voice` and `model` — the other actions that open a
    // palette page — so it does not fire while the settings page is up.
    id: "bookmark-list",
    label: "Bookmarks…",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "B", shift: true }],
    run: (ctx) => ctx.openPalettePage("bookmarks"),
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH=~/node22/bin:$PATH && npm test -w frontend`
Expected: PASS, whole suite

- [ ] **Step 6: Build**

Run: `export PATH=~/node22/bin:$PATH && npm run build -w frontend`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/keymap.ts frontend/src/lib/keymap.test.ts
git commit -m "feat(keys): b marks a sentence, n steps between marks, ⇧B lists them"
```

---

### Task 8: The mark in the reader

**Files:**
- Modify: `frontend/src/components/Reader.tsx` (the `usePlayer()` destructure, and the span's `cn(...)` at line 205-215), `frontend/src/index.css` (after the `.rd-chunk.hl-leave` rules, ~line 717)

**Interfaces:**
- Consumes: `PlayerSnapshot.bookmarkSet` from Task 5.
- Produces: the `rd-marked` class contract.

- [ ] **Step 1: Take the set from the snapshot**

In `Reader.tsx`, add `bookmarkSet` to the existing `usePlayer()` destructure.

- [ ] **Step 2: Add the class token**

In the sentence span's `cn(...)` (line 205), as the second entry — before the highlight branches, so a marked sentence that is also the current one gets both:

```tsx
                      className={cn(
                        "rd-chunk cursor-pointer rounded-sm box-decoration-clone px-0.5",
                        bookmarkSet.has(i) && "rd-marked",
                        i === prevIdx && i !== idx && "hl-leave",
```

`bookmarkSet.has(i)` is O(1) and produces one class token. Do not reach for `bookmarks.some(...)` here, and do not wrap the span in a motion component: this map runs over ~10k spans on every status poll, and per-element work here is what produced the ~600ms main-thread block the stylesheet already records.

- [ ] **Step 3: Add the rule**

In `frontend/src/index.css`, after the `.rd-chunk.hl-leave` block:

```css
/* A bookmarked sentence.

   ::before rather than a border-left or an inset box-shadow: .rd-chunk carries
   box-decoration-clone (so the highlight band closes on every wrapped line),
   which would repeat either of those at the start of every line fragment of a
   long sentence. The pseudo-element renders once, where the sentence begins.

   The negative inline start margin cancels .rd-chunk's px-0.5 so adding a mark
   does not nudge the paragraph's text. Neutral, not accented: all five --ac-*
   slots belong to the dock modules and --accent-base is reserved for playback
   state. */
.rd-marked::before {
    content: "";
    display: inline-block;
    width: 2px;
    height: 0.95em;
    margin-inline-start: -0.125rem;
    margin-inline-end: 0.3em;
    vertical-align: -0.1em;
    border-radius: 1px;
    background: color-mix(in oklab, var(--foreground) 55%, transparent);
}
```

- [ ] **Step 4: Typecheck and build**

Run: `export PATH=~/node22/bin:$PATH && npm run build -w frontend`
Expected: PASS

- [ ] **Step 5: Verify in the running app**

There is no component test harness here — vitest is node-only — so this step is a real check, not an optional one.

```bash
bash start.sh          # then open http://localhost:8765
```

Paste or load a chapter, press `b`, and confirm: a bar appears at the start of the sentence being read; the paragraph's text does not shift when it appears; pressing `b` again removes it; a marked sentence that is also the current sentence shows both the bar and the highlight band; the bar renders once on a sentence long enough to wrap several lines.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Reader.tsx frontend/src/index.css
git commit -m "feat(reader): a bar on a bookmarked sentence"
```

---

### Task 9: Ticks on the dock rail

**Files:**
- Modify: `frontend/src/components/dock/Dock.tsx:16-49` (`ProgressRail`), `:57` (the `usePlayer()` destructure), `:85` (the `<ProgressRail>` call)

**Interfaces:**
- Consumes: `PlayerSnapshot.bookmarks` from Task 5.
- Produces: nothing others depend on.

- [ ] **Step 1: Rewrite `ProgressRail`**

Replace lines 16-49 of `frontend/src/components/dock/Dock.tsx`:

```tsx
/** How close a click must land to a tick to mean that mark rather than the
 *  sentence under the pixel. The rail is 4px tall, so the ticks are far too
 *  small to be hit targets of their own — the rail snaps instead. */
const SNAP_PX = 6

/** Chapter progress as the bar's top edge; click anywhere on it to jump.
 *  Bookmarks ride it as ticks, so the marks in a chapter are visible without
 *  opening anything. */
function ProgressRail({ n, idx, marks }: { n: number; idx: number; marks: readonly Mark[] }) {
  const pct = n ? ((idx + 1) / n) * 100 : 0
  const at = (chunk: number) => (n > 1 ? (chunk / (n - 1)) * 100 : 0)
  const scrub = (e: MouseEvent<HTMLDivElement>) => {
    if (!n) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const near = marks.find((m) => Math.abs((at(m.chunk) / 100) * r.width - x) <= SNAP_PX)
    player.jump(near ? near.chunk : Math.round((x / r.width) * (n - 1)))
  }
  return (
    <div
      className="group/progress relative h-1 w-full cursor-pointer bg-secondary transition-[height] hover:h-1.5"
      onClick={scrub}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={n}
      aria-valuenow={n ? idx + 1 : 0}
      aria-label="Chapter progress"
      title="Click to jump"
    >
      <m.div
        className="relative h-full bg-(--progress-fill)"
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ type: "spring", stiffness: 200, damping: 30 }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-0 size-2.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 shadow-sm transition-opacity duration-300 group-hover/progress:opacity-100"
        />
      </m.div>
      {/* After the fill, so a tick inside the read-so-far stretch still reads.
          Neutral rather than accented: the five --ac-* slots belong to the dock
          modules and --accent-base is playback state. */}
      {marks.map((m) => (
        <div
          key={m.chunk}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground/45"
          style={{ left: `${at(m.chunk)}%` }}
        />
      ))}
    </div>
  )
}
```

Add the type import at the top of the file:

```ts
import type { Mark } from "@/lib/bookmarks"
```

- [ ] **Step 2: Pass the marks in**

At line 57, extend the destructure, and at line 85 pass them:

```tsx
  const { chunks, idx, bookmarks } = usePlayer()
```

```tsx
        <ProgressRail n={chunks.length} idx={idx} marks={bookmarks} />
```

- [ ] **Step 3: Typecheck and build**

Run: `export PATH=~/node22/bin:$PATH && npm run build -w frontend`
Expected: PASS

- [ ] **Step 4: Verify in the running app**

With the server running and a chapter loaded: mark a few sentences spread across the chapter and confirm a tick appears on the rail at each, that the ticks stay visible over the filled portion as well as the unfilled, that clicking a tick lands exactly on its sentence, that clicking elsewhere on the rail still scrubs as before, and that the dock does not change height.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/dock/Dock.tsx
git commit -m "feat(dock): bookmark ticks on the chapter rail, and a scrub that snaps to them"
```

---

### Task 10: The toast, the README, and the shipped bundle

**Files:**
- Modify: `frontend/src/lib/player.ts` (`toggleBookmark`), `README.md`
- Modify: `static/` (build output)

**Interfaces:**
- Consumes: everything above.
- Produces: the shipped app.

- [ ] **Step 1: Add the toast**

The reader's bar is the primary feedback, but with auto-scroll off the marked line can be off-screen, in which case `b` looks dead. In `frontend/src/lib/player.ts`, add the import and a stable id near the top:

```ts
import { toast } from "sonner"
```

```ts
/** One id, so repeated presses replace rather than stack — the dock must never
 *  grow, and transient messages here are toasts, never inline chrome. */
const BOOKMARK_TOAST = "bookmark"
```

Then extend `toggleBookmark`:

```ts
  toggleBookmark() {
    const chunk = this.doc.chunks[this.idx]
    if (!chunk) return
    const next = toggle(this.marks, this.idx, chunk.text)
    const added = next.length > this.marks.length
    this.setMarks(next)
    this.emit()
    this.saveBookmarks()
    toast.message(added ? `Bookmarked sentence ${this.idx + 1}` : `Bookmark removed`, {
      id: BOOKMARK_TOAST,
      duration: 1600,
    })
  }
```

- [ ] **Step 2: Run the frontend suite**

Run: `export PATH=~/node22/bin:$PATH && npm test -w frontend`
Expected: PASS. `player.test.ts` may now need `sonner` mocked the way `keymap.test.ts` mocks `./player` — if it fails on a missing DOM, add `vi.mock("sonner", () => ({ toast: { message: vi.fn() } }))` at the top of that test file.

- [ ] **Step 3: Update the README**

In `README.md`, extend the shortcuts bullet in the `## Use` list:

```
- Keyboard: `?` shows the full sheet. `⌘K` opens the command palette (voice and
  model pages, every action searchable), `⌘,` settings, `⌘P` paste. Each `⌘`
  combo has a bare-key twin (`k`, `,`, `p`) because Chrome keeps `⌘,` for its own
  settings and never delivers it to the page. `⇧↑`/`⇧↓` volume (bare arrows keep
  scrolling), `m` mute, `[`/`]` speed, `v` voice, `e` model — volume and speed
  changes show a transient readout above the dock. `b` bookmarks the sentence
  being read, `n`/`⇧N` step between bookmarks, `⇧B` lists them.
```

And replace the position bullet:

```
- Position (per chapter), voice, speed, volume, and sentence pause are saved — close anything, it resumes.
- Bookmarks (per chapter) mark a line to come back to: a bar in the margin, a
  tick on the progress rail, and a searchable list in the palette. They live in
  `state.json` beside the position, so the browser and the desktop app see the
  same marks. A re-pasted or edited chapter is a new document, and its marks
  start empty.
```

- [ ] **Step 4: Run everything**

```bash
.venv/bin/pytest -m "not slow"
export PATH=~/node22/bin:$PATH && npm test -w frontend && npm run build -w frontend
```
Expected: all PASS

- [ ] **Step 5: Commit the source, then the bundle**

The repo keeps the built bundle as its own commit — see `build: ship the windowed reader` and the several before it.

```bash
git add frontend/src/lib/player.ts README.md
git commit -m "feat(bookmarks): a toast on toggle, and README"

git add static
git commit -m "build: ship bookmarks"
```

- [ ] **Step 6: Final manual pass**

With `bash start.sh` running, walk the whole feature once: mark three sentences spread across a chapter; press `n` repeatedly and confirm it wraps from the last mark to the first; press `⇧N` and confirm it wraps the other way; open `⇧B`, confirm the rows read as the sentences they mark and that Enter starts the voice there; reload the page and confirm the marks and the ticks are still there; open the same server in a second browser tab and confirm the marks are present there too.

---

## Notes for the executor

- **Do not add `Mark` to `api.ts` as its own interface.** It is defined once, in `lib/bookmarks.ts`, and imported as a type. `bookmarks.ts` imports nothing, so there is no cycle.
- **Do not touch the `positions` map's own lack of pruning.** It is a real pre-existing bug and out of scope; only the `if pos:` truthiness fix in `append_text` is in scope, because it sits in the lines being edited and would repeat itself on bookmarks.
- **If a step's code does not apply cleanly** because a line number has drifted, find the named symbol rather than trusting the number, and keep the surrounding comment style.
