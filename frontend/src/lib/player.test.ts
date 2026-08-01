import { afterEach, beforeEach, expect, it, vi } from "vitest"

// player.ts constructs `new Audio()` at module scope, which does not exist in
// the node environment — stub it before importing the module under test.
class FakeAudio {
  src = ""
  volume = 1
  muted = false
  playbackRate = 1
  currentTime = 0
  ended = false
  addEventListener() {}
  pause() {}
  play() {
    return Promise.resolve()
  }
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Guards against a fake-timer test leaving pollStatus's re-arm scheduled
  // against a fake clock that a later test never advances.
  vi.useRealTimers()
})

it("flushPosition POSTs immediately instead of waiting out the debounce", async () => {
  vi.useFakeTimers()

  // start() chains loadVoices() -> loadDoc() -> pollStatus(), each a real
  // fetch call, so route every endpoint it touches. pollStatus's response
  // must echo the same doc_id back, or it thinks a new doc arrived and
  // re-triggers loadDoc(). Fake timers keep pollStatus's recurring
  // `setTimeout(..., POLL_MS)` from ever becoming a real, dangling timer.
  const fetchMock = vi.fn()
  fetchMock.mockImplementation(async (...args) => {
    const url = String(args[0])
    if (url.includes("/api/voices")) return { ok: true, json: async () => ({ voices: [], current: "" }) }
    if (url.includes("/api/doc")) {
      return {
        ok: true,
        json: async () => ({
          doc_id: "d1",
          chunks: [{ id: "c1", text: "hello", para: 0 }],
          position: 0,
          voice: "v1",
          speed: 1,
          volume: 1,
        }),
      }
    }
    if (url.includes("/api/status")) {
      return { ok: true, json: async () => ({ doc_id: "d1", ready: [], failed: [], blocked: null }) }
    }
    return { ok: true, json: async () => ({}) }
  })
  vi.stubGlobal("fetch", fetchMock)

  const { player } = await import("./player")
  player.start()
  // No real timers are involved before pollStatus re-arms itself, only
  // chained promises — advancing fake time by 0ms is enough to drain them.
  await vi.advanceTimersByTimeAsync(0)
  expect(player.getSnapshot().chunks.length).toBe(1)

  fetchMock.mockClear()
  player.flushPosition()

  const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/state"))
  expect(posts.length).toBe(1)
  expect(JSON.parse(posts[0][1].body)).toHaveProperty("position")
  expect(posts[0][1].keepalive).toBe(true)
})

it("flushPosition does not POST while no document has loaded yet", async () => {
  vi.resetModules()
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal("fetch", fetchMock)

  // Fresh singleton, start() never called: doc.chunks is still the empty
  // default and idx is still its pre-load 0 — exactly the window between
  // app launch and /api/doc resolving that a window-close flush must not
  // clobber a real saved position for.
  const { player } = await import("./player")
  player.flushPosition()

  const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/state"))
  expect(posts.length).toBe(0)
})
