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

/** The last mark before `idx`, wrapping to the last. null if there are none.
 *  Strictly before — hence `>=` and not `>` in the break: standing on a mark,
 *  `>` would find that mark itself and previous would look like a dead key,
 *  the same trap `nextAfter` avoids by searching strictly after. The two have
 *  to agree, or `n` and `⇧N` stop being inverses of each other. */
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
