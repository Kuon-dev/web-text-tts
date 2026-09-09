import { describe, expect, it } from "vitest"
import { SECTIONS, hashFor, parseHash } from "./view"

describe("parseHash", () => {
  it("treats anything but #settings as the reader", () => {
    expect(parseHash("")).toEqual({ view: "reader" })
    expect(parseHash("#")).toEqual({ view: "reader" })
    expect(parseHash("#other")).toEqual({ view: "reader" })
    expect(parseHash("#settingsx")).toEqual({ view: "reader" })
  })

  it("opens settings on the first section when none is given", () => {
    expect(parseHash("#settings")).toEqual({ view: "settings", section: "appearance" })
    expect(parseHash("#settings/")).toEqual({ view: "settings", section: "appearance" })
  })

  it("reads a known section and falls back on an unknown one", () => {
    expect(parseHash("#settings/reading")).toEqual({ view: "settings", section: "reading" })
    expect(parseHash("#settings/voice")).toEqual({ view: "settings", section: "voice" })
    expect(parseHash("#settings/bogus")).toEqual({ view: "settings", section: "appearance" })
  })
})

describe("hashFor", () => {
  it("is empty for the reader", () => {
    expect(hashFor({ view: "reader" })).toBe("")
  })

  it("round-trips every section", () => {
    for (const section of SECTIONS) {
      const state = { view: "settings" as const, section }
      expect(hashFor(state)).toBe(`#settings/${section}`)
      expect(parseHash(hashFor(state))).toEqual(state)
    }
  })
})
