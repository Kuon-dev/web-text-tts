import { describe, expect, it } from "vitest"
import { DEFAULT_PREFS, FONT_GROUPS, type ReadingPrefs } from "./reading"
import { FONT_FILTERS, SECTION_DEFAULTS, filterFonts, formatValue, rovingNext, stepValue } from "./settings"

describe("stepValue", () => {
  it("steps and clamps integer prefs", () => {
    expect(stepValue(18, 1, 1, 14, 26)).toBe(19)
    expect(stepValue(14, 1, -1, 14, 26)).toBe(14)
    expect(stepValue(26, 1, 1, 14, 26)).toBe(26)
    expect(stepValue(100, 5, -1, 85, 150)).toBe(95)
  })

  it("never leaks float noise into fractional steps", () => {
    expect(stepValue(1.75, 0.05, 1, 1.3, 2.4)).toBe(1.8)
    expect(stepValue(1.8, 0.05, -1, 1.3, 2.4)).toBe(1.75)
    expect(stepValue(1.1, 0.1, 1, 0.4, 2.4)).toBe(1.2)
    expect(stepValue(0.4, 0.1, -1, 0.4, 2.4)).toBe(0.4)
    expect(stepValue(2.4, 0.05, 1, 1.3, 2.4)).toBe(2.4)
  })

  it("snaps an off-grid value onto the step grid", () => {
    expect(stepValue(1.73, 0.05, 1, 1.3, 2.4)).toBe(1.8)
  })
})

describe("formatValue", () => {
  it("shows exactly the step's decimals", () => {
    expect(formatValue(18, 1)).toBe("18")
    expect(formatValue(1.75, 0.05)).toBe("1.75")
    expect(formatValue(1.8, 0.05)).toBe("1.80")
    expect(formatValue(1.1, 0.1)).toBe("1.1")
  })
})

describe("rovingNext", () => {
  const keys = ["a", "b", "c"] as const
  it("moves with arrows and wraps", () => {
    expect(rovingNext(keys, "a", "ArrowDown")).toBe("b")
    expect(rovingNext(keys, "a", "ArrowRight")).toBe("b")
    expect(rovingNext(keys, "c", "ArrowDown")).toBe("a")
    expect(rovingNext(keys, "a", "ArrowUp")).toBe("c")
    expect(rovingNext(keys, "b", "ArrowLeft")).toBe("a")
  })
  it("jumps with Home/End and ignores other keys", () => {
    expect(rovingNext(keys, "b", "Home")).toBe("a")
    expect(rovingNext(keys, "b", "End")).toBe("c")
    expect(rovingNext(keys, "b", "Enter")).toBeNull()
  })
  it("starts from the first item when the current key is not in the list", () => {
    expect(rovingNext(keys, "zzz" as never, "ArrowDown")).toBe("a")
  })
})

describe("SECTION_DEFAULTS", () => {
  it("partitions every reading pref across the three resettable sections", () => {
    const covered = Object.values(SECTION_DEFAULTS).flatMap((p) => Object.keys(p))
    expect(new Set(covered).size).toBe(covered.length)
    expect(covered.sort()).toEqual(Object.keys(DEFAULT_PREFS).sort())
  })

  it("restores the default value for each key", () => {
    for (const patch of Object.values(SECTION_DEFAULTS)) {
      for (const [k, v] of Object.entries(patch)) {
        expect(v).toEqual(DEFAULT_PREFS[k as keyof ReadingPrefs])
      }
    }
  })
})

describe("filterFonts", () => {
  it("lists All first, then every group label", () => {
    expect(FONT_FILTERS).toEqual(["All", ...FONT_GROUPS.map((g) => g.label)])
  })
  it("returns all groups for All and for an unknown filter", () => {
    expect(filterFonts("All")).toBe(FONT_GROUPS)
    expect(filterFonts("nope")).toBe(FONT_GROUPS)
  })
  it("returns exactly the named group", () => {
    expect(filterFonts("Monospace")).toEqual([{ label: "Monospace", fonts: ["jetbrains", "courier"] }])
  })
})
