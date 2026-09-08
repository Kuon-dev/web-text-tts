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
  addEventListener(_name: string, _fn: () => void) {}
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

/** Fake <audio> that records its "ended" listener so a test can fire it. */
class EndableAudio extends FakeAudio {
  static instances: EndableAudio[] = []
  listeners: Record<string, () => void> = {}
  constructor() {
    super()
    EndableAudio.instances.push(this)
  }
  addEventListener(name: string, fn: () => void) {
    this.listeners[name] = fn
  }
}

async function loadTwoChunkDoc(pause_ms: number) {
  vi.resetModules()
  vi.useFakeTimers()
  EndableAudio.instances = []
  vi.stubGlobal("Audio", EndableAudio)
  const fetchMock = vi.fn().mockImplementation(async (...args) => {
    const url = String(args[0])
    if (url.includes("/api/voices")) return { ok: true, json: async () => ({ voices: [], current: "" }) }
    if (url.includes("/api/doc")) {
      return {
        ok: true,
        json: async () => ({
          doc_id: "d1",
          chunks: [
            { id: "c1", text: "One.", para: 0 },
            { id: "c2", text: "Two.", para: 0 },
          ],
          position: 0,
          voice: "v1",
          speed: 1,
          volume: 1,
          pause_ms,
        }),
      }
    }
    if (url.includes("/api/status")) {
      return { ok: true, json: async () => ({ doc_id: "d1", ready: ["c1", "c2"], failed: [], blocked: null }) }
    }
    return { ok: true, json: async () => ({}) }
  })
  vi.stubGlobal("fetch", fetchMock)
  const { player } = await import("./player")
  player.start()
  await vi.advanceTimersByTimeAsync(0)
  const audio = EndableAudio.instances[0]
  player.togglePlay()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c1")
  return { player, audio }
}

it("waits pause_ms after a chunk ends before starting the next one", async () => {
  const { player, audio } = await loadTwoChunkDoc(500)
  expect(player.getSnapshot().pauseMs).toBe(500)

  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  // The reader highlight moves to the next sentence at once, but audio waits.
  expect(player.getSnapshot().idx).toBe(1)
  expect(audio.src).toContain("c1")

  await vi.advanceTimersByTimeAsync(499)
  expect(audio.src).toContain("c1")
  await vi.advanceTimersByTimeAsync(1)
  expect(audio.src).toContain("c2")
})

it("scales the pause by playback speed", async () => {
  const { player, audio } = await loadTwoChunkDoc(1000)
  player.setSpeed(2)

  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(499)
  expect(audio.src).toContain("c1")
  await vi.advanceTimersByTimeAsync(1)
  expect(audio.src).toContain("c2")
})

it("starts the next chunk immediately when pause_ms is 0", async () => {
  const { audio } = await loadTwoChunkDoc(0)
  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c2")
})

it("pausing during the gap cancels the pending chunk start", async () => {
  const { player, audio } = await loadTwoChunkDoc(500)
  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(100)
  player.togglePlay() // pause
  await vi.advanceTimersByTimeAsync(1000)
  expect(audio.src).toContain("c1")
  expect(player.getSnapshot().playing).toBe(false)
})

it("jumping during the gap plays the target at once and drops the stale timer", async () => {
  const { player, audio } = await loadTwoChunkDoc(500)
  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(100)
  const playSpy = vi.spyOn(audio, "play")
  player.jump(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c1")
  expect(playSpy).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  // the stale gap timer must not fire a second play() for c2
  expect(playSpy).toHaveBeenCalledTimes(1)
  expect(audio.src).toContain("c1")
})

it("setPause commits pause_ms to the server", async () => {
  const { player } = await loadTwoChunkDoc(300)
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  fetchMock.mockClear()
  player.setPause(750)
  expect(player.getSnapshot().pauseMs).toBe(750)
  player.commitPause()
  await vi.advanceTimersByTimeAsync(0)
  const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/state"))
  expect(posts.length).toBe(1)
  expect(JSON.parse(posts[0][1].body)).toEqual({ pause_ms: 750 })
})
