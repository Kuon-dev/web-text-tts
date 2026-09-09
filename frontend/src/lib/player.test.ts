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

/** Fake <audio> that records its listeners so a test can fire them. */
class EndableAudio extends FakeAudio {
  static instances: EndableAudio[] = []
  listeners: Record<string, () => void> = {}
  paused = 0
  constructor() {
    super()
    EndableAudio.instances.push(this)
  }
  plays = 0
  addEventListener(name: string, fn: () => void) {
    this.listeners[name] = fn
  }
  pause() {
    this.paused += 1
  }
  play() {
    this.plays += 1
    return Promise.resolve()
  }
}

/** Loads a two-sentence doc, starts playback, and hands back both elements:
 *  the player owns one <audio> for sentences and one for the silent gap clip. */
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
  const [audio, gap] = EndableAudio.instances
  player.togglePlay()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c1")
  return { player, audio, gap }
}

it("primes the silent clip on the play gesture, so a strict browser allows it later", async () => {
  // Safari and iOS only let an element play if it was started by a gesture at
  // least once; the gap element's own plays all happen later, unprompted.
  const { gap } = await loadTwoChunkDoc(500)
  expect(gap.plays).toBe(1)
  expect(gap.src).toContain("data:audio/wav")
  expect(gap.paused).toBeGreaterThan(0) // primed, then immediately silenced
})

it("times the pause with a silent clip, not a timer that a hidden tab throttles", async () => {
  const { player, audio, gap } = await loadTwoChunkDoc(500)
  expect(player.getSnapshot().pauseMs).toBe(500)

  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  // The reader highlight moves on at once; the next sentence waits on the clip.
  expect(player.getSnapshot().idx).toBe(1)
  expect(gap.src).toContain("data:audio/wav")
  expect(audio.src).toContain("c1")

  // No amount of wall-clock time may start it — only the clip ending does.
  await vi.advanceTimersByTimeAsync(60_000)
  expect(audio.src).toContain("c1")

  gap.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c2")
})

it("scales the pause by playback speed", async () => {
  const { player, audio, gap } = await loadTwoChunkDoc(1000)
  player.setSpeed(2)

  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  // A 1000ms clip played at 2x lasts 500ms, so a faster narrator breathes faster.
  expect(gap.playbackRate).toBe(2)
})

it("starts the next sentence immediately when the pause is 0", async () => {
  const { audio, gap } = await loadTwoChunkDoc(0)
  const primed = gap.plays
  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c2")
  expect(gap.plays).toBe(primed) // no clip beyond the one-off priming
})

it("pausing during the gap stops the clip and cancels the pending sentence", async () => {
  const { player, audio, gap } = await loadTwoChunkDoc(500)
  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)

  player.togglePlay() // pause
  expect(gap.paused).toBeGreaterThan(0)
  expect(player.getSnapshot().playing).toBe(false)

  // A clip that ends anyway (the stop raced the media thread) must not resume.
  gap.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c1")
})

it("jumping during the gap plays the target and ignores the stale clip end", async () => {
  const { player, audio, gap } = await loadTwoChunkDoc(500)
  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)

  player.jump(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c1")

  gap.listeners.ended()
  await vi.advanceTimersByTimeAsync(0)
  expect(audio.src).toContain("c1") // still the jump target, not c2
})

it("falls back to playing the next sentence when the clip cannot play", async () => {
  const { audio, gap } = await loadTwoChunkDoc(500)
  // Autoplay policies can reject a play() on the gap element; silence must
  // never become a dead end that strands playback mid-chapter.
  gap.play = () => Promise.reject(new Error("NotAllowedError"))

  audio.listeners.ended()
  await vi.advanceTimersByTimeAsync(1000)
  expect(audio.src).toContain("c2")
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

/** Boots the player with a controllable /api/state and /api/status.
 *  `state.resolve` releases the in-flight engine switch; `engineInfo` is what
 *  the next status poll reports. */
async function bootForEngineSwitch() {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal("Audio", FakeAudio)
  let engineInfo = { engine: "kokoro", label: "Kokoro-82M", mode: "auto", active: "gpu", gpu_available: true, loading: false, speed: 0 }
  let release: ((v: unknown) => void) | null = null
  const fetchMock = vi.fn().mockImplementation(async (...args) => {
    const url = String(args[0])
    if (url.includes("/api/voices")) return { ok: true, json: async () => ({ voices: [], current: "" }) }
    if (url.includes("/api/doc")) {
      return { ok: true, json: async () => ({ doc_id: "d1", chunks: [{ id: "c1", text: "One.", para: 0 }], position: 0, voice: "v1", speed: 1, volume: 1 }) }
    }
    if (url.includes("/api/status")) {
      return { ok: true, json: async () => ({ doc_id: "d1", ready: [], failed: [], blocked: null, engine: engineInfo }) }
    }
    if (url.includes("/api/state")) {
      await new Promise((r) => (release = r))
      return { ok: true, json: async () => ({ ok: true, rechunked: false }) }
    }
    return { ok: true, json: async () => ({}) }
  })
  vi.stubGlobal("fetch", fetchMock)
  const { player } = await import("./player")
  player.start()
  await vi.advanceTimersByTimeAsync(0)
  return {
    player,
    fetchMock,
    finishSwitch: async () => {
      release?.(undefined)
      await vi.advanceTimersByTimeAsync(0)
    },
    poll: async (info: Partial<typeof engineInfo>) => {
      engineInfo = { ...engineInfo, ...info }
      await vi.advanceTimersByTimeAsync(2000)
    },
  }
}

it("names the engine being switched to while the request is still in flight", async () => {
  const { player, finishSwitch } = await bootForEngineSwitch()

  const done = player.setEngine("qwen3")
  await vi.advanceTimersByTimeAsync(0)
  // POST /api/state blocks behind EngineManager's lock for as long as the
  // chunk in flight takes — the UI has to say something for that whole window.
  expect(player.getSnapshot().switchingTo).toBe("qwen3")

  await finishSwitch()
  await done
  expect(player.getSnapshot().switchingTo).toBe(null)
})

it("clears the switching state when the engine switch is rejected", async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal("Audio", FakeAudio)
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (...args) => {
    const url = String(args[0])
    if (url.includes("/api/voices")) return { ok: true, json: async () => ({ voices: [], current: "" }) }
    if (url.includes("/api/doc")) return { ok: true, json: async () => ({ doc_id: "d1", chunks: [], position: 0, voice: "v1", speed: 1, volume: 1 }) }
    if (url.includes("/api/status")) return { ok: true, json: async () => ({ doc_id: "d1", ready: [], failed: [], blocked: null }) }
    return { ok: false, status: 400, json: async () => ({ detail: "no GPU" }) }
  }))
  const { player } = await import("./player")
  player.start()
  await vi.advanceTimersByTimeAsync(0)

  await expect(player.setEngine("qwen3")).rejects.toThrow("no GPU")
  expect(player.getSnapshot().switchingTo).toBe(null)
})

it("ignores a second engine switch while one is still in flight", async () => {
  const { player, fetchMock, finishSwitch } = await bootForEngineSwitch()

  const first = player.setEngine("qwen3")
  await vi.advanceTimersByTimeAsync(0)
  await player.setEngine("qwen3")     // impatient second click on the same card
  await player.setEngine("kokoro")    // ...or on a different one

  const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/state"))
  expect(posts.length).toBe(1)
  await finishSwitch()
  await first
})

it("announces the new engine only once its weights have finished loading", async () => {
  const { player, finishSwitch, poll } = await bootForEngineSwitch()
  const ready: string[] = []
  player.onEngineReady((label) => ready.push(label))

  const done = player.setEngine("qwen3")
  await finishSwitch()
  await done

  await poll({ engine: "qwen3", label: "Qwen3-TTS 1.7B", loading: true })
  expect(ready).toEqual([])          // still loading — nothing to announce yet

  await poll({ loading: false })
  expect(ready).toEqual(["Qwen3-TTS 1.7B"])

  await poll({ loading: false })
  expect(ready).toEqual(["Qwen3-TTS 1.7B"])   // one-shot, not once per poll
})

it("stays quiet when the new engine's weights were already resident", async () => {
  const { player, finishSwitch, poll } = await bootForEngineSwitch()
  const ready: string[] = []
  player.onEngineReady((label) => ready.push(label))

  const done = player.setEngine("qwen3")
  await finishSwitch()
  await done

  // Never reports loading: the switch itself was the whole wait, and the
  // card already showed it. A "ready" toast here would be noise — and after
  // a switch with no load, a promise the next play may not keep.
  await poll({ engine: "qwen3", label: "Qwen3-TTS 1.7B", loading: false })
  await poll({ loading: false })
  expect(ready).toEqual([])
})
