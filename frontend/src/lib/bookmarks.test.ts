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
    // Its own array, not the shared `marks`: a snapshot taken here would be a
    // snapshot of whatever the tests above already did to it.
    const input: Mark[] = [{ chunk: 2, excerpt: "Two." }, { chunk: 5, excerpt: "Five." }]
    toggle(input, 3, "Three.")   // the add path
    toggle(input, 2, "Two.")     // the remove path
    // toEqual against the whole array, not toHaveLength: the length survives an
    // in-place sort and a mutated entry alike, and `[...marks, m].sort()` is one
    // keystroke from `marks.sort()` — which would reorder a list the caller
    // still holds and every other function here assumes is sorted.
    expect(input).toEqual([{ chunk: 2, excerpt: "Two." }, { chunk: 5, excerpt: "Five." }])
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
