import { describe, expect, it } from "vitest"
import { readerMaxWidth } from "./reading"

describe("readerMaxWidth", () => {
  it("is 16px per unit plus the tile's padding allowance", () => {
    expect(readerMaxWidth(44)).toBe(800)
    expect(readerMaxWidth(34)).toBe(640)
    expect(readerMaxWidth(60)).toBe(1056)
  })
})
