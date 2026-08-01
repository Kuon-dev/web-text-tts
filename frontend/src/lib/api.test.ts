import { afterEach, describe, expect, it } from "vitest"
import { apiUrl, audioUrl, imageUrl } from "./api"

afterEach(() => {
  delete (globalThis as { __API_BASE__?: string }).__API_BASE__
})

describe("apiUrl", () => {
  it("returns the path unchanged when no base is set (web app)", () => {
    expect(apiUrl("/api/doc")).toBe("/api/doc")
    expect(audioUrl("abc")).toBe("/api/audio/abc")
    expect(imageUrl("def")).toBe("/api/image/def")
  })

  it("prefixes the base when one is set (desktop)", () => {
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = "http://127.0.0.1:8765"
    expect(apiUrl("/api/doc")).toBe("http://127.0.0.1:8765/api/doc")
    expect(audioUrl("abc")).toBe("http://127.0.0.1:8765/api/audio/abc")
  })

  it("is read at call time, not module-eval time", () => {
    expect(apiUrl("/api/doc")).toBe("/api/doc")
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = "http://127.0.0.1:9999"
    expect(apiUrl("/api/doc")).toBe("http://127.0.0.1:9999/api/doc")
  })

  // player.ts:246 and :380 compare `audio.src.endsWith(audioUrl(cid))`.
  // With base "" the element absolutizes to <origin>/api/audio/x, which ends
  // with the relative form. With an absolute base both sides are identical.
  // Either way the base must carry no trailing slash and no query string.
  it("keeps the endsWith invariant usable under both bases", () => {
    expect("http://localhost:8765/api/audio/x".endsWith(audioUrl("x"))).toBe(true)
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = "http://127.0.0.1:8765"
    expect("http://127.0.0.1:8765/api/audio/x".endsWith(audioUrl("x"))).toBe(true)
  })
})
