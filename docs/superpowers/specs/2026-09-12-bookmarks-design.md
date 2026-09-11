# Bookmarks

Marks inside a chapter. Press `b` and the sentence the voice is reading gets a
mark; `n` / `⇧N` step between marks; `⇧B` lists them in the palette and jumps.
Marked lines carry a bar in the reader and a tick on the dock's progress rail.

Distinct from the reading position, which already resumes on its own: a
position is where you *stopped*, a bookmark is a place you chose.

## Decisions

- **Server-side, in `state.json`, as a sibling of `positions`.** Every
  document-scoped value in this app is already there (`server.py:30`); the
  browser holds exactly two keys, `novel-tts:theme` and `novel-tts:reading`,
  and both are device-scoped. The Tauri shell attaches to an already-running
  server, so it shares `state.json` but not a localStorage origin — bookmarks
  in the browser would be invisible in the desktop app whose reading position
  syncs fine.
- **A mark is a chunk index plus the sentence text.** The text is a staleness
  guard, not a feature. `position()` clamps an out-of-range index to the last
  sentence (`server.py:145`), which is right for a resume point and wrong for
  a bookmark — it would aim at the end of the chapter instead of admitting it
  is lost. Comparing the stored text against the live chunk turns a
  mis-aimed mark into an absent one. It also makes `state.json` readable by eye.
- **One whole-list route, not add + delete.** `PUT /api/bookmarks` takes the
  full set. Toggling is a set operation the client already performs;
  `POST /api/state` is patch-shaped and cannot express a removal, and a
  `DELETE /api/bookmarks/{i}` would need an identity that a bare index does
  not have.
- **Going to a bookmark moves the playhead.** `player.jump(i)` — the same
  thing clicking a sentence does. It clamps, persists, keeps playing if
  playing, and lets `useFollowChunk` glide the scroller. A viewport-only peek
  would need `follow.ts` to export an imperative aim, and would leave the
  voice somewhere the eye is not.
- **Bare positions. No notes.** The sentence labels its own palette row, and a
  note would need an editing surface that `controls.tsx` does not have.
- **No dock module.** The rail ticks and the palette page carry it. A dock
  button would also keep focus after a click, so the next `space` would
  re-activate the button instead of toggling playback.

## Storage — `state.json`

```jsonc
"bookmarks": {
  "<doc_id>": [
    {"chunk": 87,  "excerpt": "The gate opened at dusk."},
    {"chunk": 203, "excerpt": "He said nothing."}
  ]
}
```

Sorted by `chunk`, unique, at most `MAX_MARKS = 200` per document. Over the
cap the server keeps the first 200 in chunk order — a backstop against a
malformed request, not a UX decision; 200 marks in one chapter is not a real
case.

The map keeps `MAX_DOCS = 20` documents. Recency is dict insertion order, not
a stored timestamp: a write pops its `doc_id` and reinserts it so the entry
moves to the end, then the map is trimmed from the front. `positions` is
never pruned and the live `state.json` already carries three orphaned
chapters — this map does not inherit that. `ImageStore.prune` is the in-repo
precedent for a cap.

`DEFAULT_STATE` gains `"bookmarks": {}`. Because absent keys fall back to
`DEFAULT_STATE`, an existing `state.json` needs no migration — but the nested
dict must be copied per `AppState` alongside `positions` and `voices`
(`server.py:96-99`), or every instance in the test suite shares one
module-level dict. The loader gets the same `isinstance(..., dict)` guard
`positions` has at `server.py:106`.

## The server — `server.py`

### `PUT /api/bookmarks`

```
request   {"chunks": [12, 87, 203], "doc_id": "…"}
response  {"bookmarks": [{"chunk": 12, "excerpt": "…"}, …]}
```

`doc_id` is optional — `static/` is a committed bundle and the desktop shell
can be running an older one — but the client always sends it. Without it the
indices apply to whatever document the server holds *now*: a document swapped
by `load_text`, another client, or the shell inside the browser's 2s poll
window would take the previous chapter's indices and have its own excerpts
written against them, which the client's `dropStale` then has no way to catch.
A body naming another document is dropped silently and answered `200` with the
current marks — there is nothing to retry, and that list is the correction.

Validate-then-apply, the shape `post_state` uses (`server.py:314`) so a bad
element cannot leave a half-written list:

1. **Validate** — every element an `int`; drop anything outside
   `0 ≤ i < len(chunks)`; dedupe; sort; truncate to `MAX_MARKS`.
2. **Apply** — `with st.lock:` write `st.state["bookmarks"][st.doc_id]`, each
   entry's `excerpt` taken from `self.chunks[i].text` (the client never sends
   text), prune the map to `MAX_DOCS`, `st.save_state()`.

An empty list is a valid request and removes the document's entry.

### `doc_json()` — `server.py:163`

Gains `"bookmarks": [{"chunk": …, "excerpt": …}, …]`, read through an accessor
that **drops** anything addressing past the end rather than clamping it to the
last sentence the way `position()` does — see the anchoring decision above: a
mark silently pointing at the end of the chapter is worse than one that is
gone. The client already
refetches `/api/doc` whenever `doc_id` changes, so this costs no new round
trip and no new polling.

### Carry across an append — `mcp_tools.py`

`append_text` mints a new `doc_id` (it is a sha1 of the whole text,
`chunker.py:91`) and already copies the old position onto it. It copies the
bookmark list the same way; an append preserves the chunk prefix, so every
stored index stays valid and every excerpt still matches.

`mcp_tools.py:85` guards the position carry with `if pos:`, which silently
drops a saved position of `0`. Fixed to `is not None` in passing — the same
bug on a bookmark set on the first sentence would be worse, and the fix
belongs in the code being edited.

## The client

### `src/lib/bookmarks.ts` (new)

Pure exports, no React and no DOM — `vitest` runs in `environment: "node"`
and collects `src/**/*.test.ts` only, so anything worth asserting has to live
here:

```ts
export interface Mark { chunk: number; excerpt: string }

export function toggle(marks: readonly Mark[], chunk: number, excerpt: string): Mark[]
export function nextAfter(marks: readonly Mark[], idx: number): number | null   // wraps
export function prevBefore(marks: readonly Mark[], idx: number): number | null  // wraps
export function dropStale(marks: readonly Mark[], chunks: readonly Chunk[]): Mark[]
export function indexSet(marks: readonly Mark[]): ReadonlySet<number>
```

`dropStale` removes any mark whose `chunk` is out of range or whose `excerpt`
no longer equals `chunks[chunk].text`. In practice it fires only on a
hand-edited `state.json` or a carried list over changed text; it exists so
that case is silent rather than wrong.

### `src/lib/player.ts`

`PlayerSnapshot` (`:19-39`) gains `bookmarks: ReadonlySet<number>` — a `Set`,
because the reader probes it per sentence. `Doc` in `lib/api.ts` gains the
matching optional field.

Four methods on the singleton: `toggleBookmark()`, `nextBookmark()`,
`prevBookmark()`, `jumpToBookmark(i)`. `toggleBookmark` marks
`this.idx` — the sentence the voice is on — and the three that move call
`jump()`. Writes go out debounced and `keepalive: true`, the way
`savePosition` does (`:553-569`), so a mark survives a webview teardown.

`loadDoc` runs the incoming list through `dropStale` before building the set.

### `src/lib/keymap.ts`

Four rows in `ACTIONS`, the only place a binding is declared and the source
both the ⌘K palette and the `?` sheet generate themselves from:

| id | key | label | group | scope |
|---|---|---|---|---|
| `bookmark-toggle` | `b` | Toggle bookmark | Bookmarks | reader |
| `bookmark-next` | `n` | Next bookmark | Bookmarks | reader |
| `bookmark-prev` | `⇧N` | Previous bookmark | Bookmarks | reader |
| `bookmark-list` | `⇧B` | Bookmarks | Bookmarks | reader |

`Group` gains a `"Bookmarks"` member. Four rows would swell `Playback`, and
the union is closed precisely so the sheet's headings stay enumerable;
declaration order in `ACTIONS` sets where the group lands in both UIs. All
four are `reader`-scoped, matching `voice` and `model` — the existing actions
that open a palette page — so none of them fire while settings is open.

`bookmark-prev` carries `pair: { with: "bookmark-next" }` so the sheet renders
one row. `b`, `n` and `⇧B` are unclaimed — taken are `k , p ? space ← → ↑ ↓ m
[ ] v e`, and `z` is pinned unbound by a test. Letters compare
case-insensitively and require shift *off* (`keymap.ts:228`), so `n` and `⇧N`
separate cleanly; the shift-fallthrough at `:227` only bites non-letter specs
like the arrows, which is why `⇧←` would need declaring above `prev-sentence`
and `⇧N` does not.

`KeymapCtx.openPalettePage` widens from `"voice" | "model"` to include
`"bookmarks"`, which also widens `PalettePage` at `CommandPalette.tsx:28` and
the typed `ctx` literal in `App.tsx`.

### `src/components/CommandPalette.tsx`

A third page beside `voice` and `model`. Rows show the excerpt, truncated to
one line, ordered by position in the chapter and labelled with their sentence
number; Enter jumps. Empty state: one muted line saying `b` marks the current
sentence.

## The two surfaces

### The reader — `Reader.tsx:206`

One extra class token on the sentence span, from `bookmarks.has(i)`:

```tsx
className={cn("rd-chunk cursor-pointer rounded-sm box-decoration-clone px-0.5",
              marked.has(i) && "rd-marked", …)}
```

An O(1) `Set` probe and nothing else. That tree is ~10k spans re-rendered on
every 2s poll and twice per sentence advance; an array `.some()` inside the
map, a per-span motion component, or a per-sentence observer is what produced
the ~600ms main-thread block recorded in `index.css`.

`.rd-marked::before` draws the bar: an `inline-block` rule with a
compensating negative `margin-inline-start` so the text does not shift. A
`border-left` or an inset `box-shadow` would repeat on every wrapped line
fragment under the existing `box-decoration-clone`.

### The dock rail — `Dock.tsx:16`

Absolutely-positioned 2px ticks inside `ProgressRail` at `left: i/(n-1)`,
`pointer-events-none`, `bg-foreground` at reduced opacity. All five `--ac-*`
accent slots are assigned to the dock modules and `--accent-base` is reserved
for playback state, so no new hue is minted.

The rail is 4px tall, so the ticks are indicators rather than hit targets:
`scrub` snaps to the nearest bookmark when a click lands within a few pixels
of a tick, and otherwise behaves exactly as it does today. The dock's height
does not change; `--dock-h` is unaffected.

### Feedback

One sonner toast with a stable id, replacing itself on each press — the
documented pattern for transient messages, since the dock must never grow.
It covers the case where auto-scroll is off and the marked line is off-screen,
where the mark alone would be invisible.

## Integration

- `server.py` — `DEFAULT_STATE`, the per-instance copy, the loader guard, a
  `bookmarks()` accessor, `doc_json()`, one new route.
- `mcp_tools.py` — carry on `append_text`; the `if pos:` fix.
- `lib/bookmarks.ts` (new), `lib/player.ts`, `lib/api.ts`, `lib/keymap.ts`,
  `components/CommandPalette.tsx`, `components/Reader.tsx`,
  `components/dock/Dock.tsx`, `App.tsx`, `index.css`.
- `npm run build -w frontend` emits into `../static`, which FastAPI serves.
  The repo keeps that as its own `build: ship …` commit.

## Testing

Python — flat `def test_<sentence>(tmp_path)` functions in
`tests/test_server.py`, fakes imported from that module:

- the PUT drops out-of-range indices, dedupes, sorts, and caps at `MAX_MARKS`
- an empty list clears the document's entry
- bookmarks survive a restart (a fresh app over the same `data_dir`)
- `doc_json` emits them
- `append_text` carries them onto the new `doc_id`, **including a bookmark on
  sentence 0**
- the map prunes to `MAX_DOCS`

Vitest — `lib/bookmarks.test.ts`: toggle adds and removes; `nextAfter` /
`prevBefore` wrap at both ends and return `null` on an empty list; `dropStale`
removes an index out of range and a mark whose excerpt has drifted.

Two existing tests need updating, both honest pins rather than collateral:

- `keymap.test.ts:295` asserts the paired actions are exactly
  `["prev-sentence", "volume-up", "speed-down"]` — becomes four.
- the player mock at `keymap.test.ts:9-18` has six methods and a snapshot of
  `{idx: 3}`; the new methods and `bookmarks` must be added or the actions
  throw `TypeError`.

## Non-goals

- **Notes on a bookmark.** The excerpt labels the row.
- **A cross-chapter library.** It needs a document store, stable identities
  and titles; the server holds exactly one document at `<data_dir>/novel.txt`,
  `doc_id` is a content hash that changes on any edit, and no title is
  persisted anywhere. That is a bigger feature, and bookmarks fall out of it
  for free afterwards.
- **Re-anchoring onto an edited or re-pasted chapter.** A re-paste mints a new
  `doc_id`, so its marks are absent rather than misplaced. The stored excerpt
  is what makes a later re-anchoring pass possible; adding the field
  afterwards could not rescue marks already written.
- **Bookmarking an illustration.** `[img:<sha1>]` lines occupy their own
  paragraph index and are skipped by the chunker, so an image has no chunk
  index and no `c<i>` element to aim at.
- **Convergence between two open clients.** There is no push channel and no
  `bookmarks_rev` on `/api/status`; the browser refetches `/api/doc` only when
  `doc_id` changes, so the last write wins. Note that this is *worse* than what
  `positions` gives, not the same: a position is a scalar, so last-write-wins
  means one of two numbers survives, and the loser was only a resume point. A
  bookmark write is a whole list, so client B's PUT **erases every mark client A
  made** — and A goes on displaying them, because `doc_id` never changed and
  nothing tells it to refetch. Two clients on one chapter is not a case this
  design handles; it is still a non-goal, and nothing here should be relied on
  as a guarantee of anything.
