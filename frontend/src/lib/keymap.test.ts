import { afterEach, describe, expect, it, vi } from "vitest"
import { ACTIONS, formatSpec, isMac, matchAction, type KeyEventLike, type KeymapCtx, type KeymapGuards } from "./keymap"
import { player } from "./player"

// keymap imports the player singleton, and player.ts constructs `new Audio()`
// at module scope — which does not exist in the node environment. Replacing the
// module outright is cheaper than stubbing Audio, and it lets the run() tests
// assert exactly which player call each action makes.
vi.mock("./player", () => ({
  player: {
    togglePlay: vi.fn(),
    jump: vi.fn(),
    toggleMute: vi.fn(),
    nudgeVolume: vi.fn(),
    nudgeSpeed: vi.fn(),
    getSnapshot: vi.fn(() => ({ idx: 3 })),
  },
}))

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods,
})

/** Nothing focused, nothing open: the plain reader. */
const FREE: KeymapGuards = { textEntry: false, controlFocused: false, overlayOpen: false }

const idFor = (e: KeyEventLike, opts: KeymapGuards = FREE) => matchAction(e, opts)?.id ?? null

const actionById = (id: string) => {
  const action = ACTIONS.find((a) => a.id === id)
  if (!action) throw new Error(`no action ${id}`)
  return action
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("ACTIONS", () => {
  it("gives every action a unique id and at least one binding", () => {
    const ids = ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const action of ACTIONS) expect(action.keys.length).toBeGreaterThan(0)
  })

  it("gives every mod combo an unmodified twin, so nothing is dead in a browser tab", () => {
    for (const action of ACTIONS) {
      if (!action.keys.some((k) => k.mod)) continue
      expect(action.keys).toContainEqual({ key: action.keys[0].key })
    }
  })
})

describe("matchAction — rule 1: mod is meta OR ctrl", () => {
  it("fires the same action from ⌘K and Ctrl+K, with no platform branch", () => {
    expect(idFor(ev("k", { metaKey: true }))).toBe("palette")
    expect(idFor(ev("k", { ctrlKey: true }))).toBe("palette")
  })
})

describe("matchAction — rule 2: an unmodified spec requires meta, ctrl and alt off", () => {
  it("does not let the bare , twin fire a second time on ⌘,", () => {
    // Both specs live on the same action, so a match must resolve once, through
    // the mod spec — never through the twin as well.
    expect(idFor(ev(",", { metaKey: true }))).toBe("settings")
    expect(idFor(ev(","))).toBe("settings")
    expect(matchAction(ev(",", { metaKey: true }), FREE)?.keys[0]).toEqual({ key: ",", mod: true })
  })

  it("ignores Option+key, which types real characters on a Mac", () => {
    expect(idFor(ev("m", { altKey: true }))).toBeNull()
    expect(idFor(ev("π", { altKey: true }))).toBeNull()
    expect(idFor(ev("ArrowLeft", { altKey: true }))).toBeNull()
  })

  it("ignores Ctrl+arrow so the reader's own scroll keys stay untouched", () => {
    expect(idFor(ev("ArrowRight", { ctrlKey: true }))).toBeNull()
  })
})

describe("matchAction — rule 3: shift is checked only when the spec sets it", () => {
  it("requires shift for the explicit ⇧↑ / ⇧↓ bindings", () => {
    expect(idFor(ev("ArrowUp", { shiftKey: true }))).toBe("volume-up")
    expect(idFor(ev("ArrowDown", { shiftKey: true }))).toBe("volume-down")
    expect(idFor(ev("ArrowUp"))).toBeNull()
    expect(idFor(ev("ArrowDown"))).toBeNull()
  })

  it("matches ? on its key alone, however the layout produced it", () => {
    expect(idFor(ev("?", { shiftKey: true }))).toBe("help")
    expect(idFor(ev("?"))).toBe("help")
  })

  it("matches letters case-insensitively but only with shift off", () => {
    expect(idFor(ev("m"))).toBe("mute")
    expect(idFor(ev("M"))).toBe("mute") // caps lock, shift not held
    expect(idFor(ev("M", { shiftKey: true }))).toBeNull()
  })
})

describe("matchAction — rule 4: auto-repeat", () => {
  it("ramps the repeatable actions and swallows the rest", () => {
    expect(idFor(ev("ArrowUp", { shiftKey: true, repeat: true }))).toBe("volume-up")
    expect(idFor(ev("[", { repeat: true }))).toBe("speed-down")
    expect(idFor(ev(" ", { repeat: true }))).toBeNull()
    expect(idFor(ev("m", { repeat: true }))).toBeNull()
  })
})

describe("matchAction — the textEntry guard", () => {
  const typing: KeymapGuards = { ...FREE, textEntry: true }

  it("blocks every modifier-less binding so keys type themselves instead", () => {
    expect(idFor(ev("p"), typing)).toBeNull()
    expect(idFor(ev(","), typing)).toBeNull()
    expect(idFor(ev("?"), typing)).toBeNull()
    expect(idFor(ev(" "), typing)).toBeNull()
  })

  it("still lets the mod combos through", () => {
    expect(idFor(ev("k", { metaKey: true }), typing)).toBe("palette")
    expect(idFor(ev("p", { ctrlKey: true }), typing)).toBe("paste")
  })
})

describe("matchAction — the reader-scope guard", () => {
  it("stands the reader actions down for a focused control, keeping global ones", () => {
    const focused: KeymapGuards = { ...FREE, controlFocused: true }
    expect(idFor(ev(" "), focused)).toBeNull() // space activates the dock button
    expect(idFor(ev("m"), focused)).toBeNull()
    expect(idFor(ev("?"), focused)).toBe("help")
    expect(idFor(ev(","), focused)).toBe("settings")
  })

  it("stands the reader actions down while an overlay is open", () => {
    const overlaid: KeymapGuards = { ...FREE, overlayOpen: true }
    expect(idFor(ev("ArrowLeft"), overlaid)).toBeNull()
    expect(idFor(ev("v"), overlaid)).toBeNull()
    expect(idFor(ev("k", { metaKey: true }), overlaid)).toBe("palette")
  })
})

describe("matchAction — alias resolution", () => {
  it("resolves both the bare twin and the mod combo to one action", () => {
    for (const [key, id] of [["k", "palette"], [",", "settings"], ["p", "paste"]] as const) {
      expect(idFor(ev(key))).toBe(id)
      expect(idFor(ev(key, { metaKey: true }))).toBe(id)
      expect(idFor(ev(key, { ctrlKey: true }))).toBe(id)
    }
  })

  it("binds every key in the table", () => {
    expect(idFor(ev(" "))).toBe("play-pause")
    expect(idFor(ev("ArrowLeft"))).toBe("prev-sentence")
    expect(idFor(ev("ArrowRight"))).toBe("next-sentence")
    expect(idFor(ev("]"))).toBe("speed-up")
    expect(idFor(ev("v"))).toBe("voice")
    expect(idFor(ev("e"))).toBe("model")
  })

  it("returns null for a key nobody claims", () => {
    expect(idFor(ev("z"))).toBeNull()
    expect(idFor(ev("Escape"))).toBeNull() // Radix and SettingsPage own Escape
  })
})

describe("run", () => {
  const ctx: KeymapCtx = {
    openPalette: vi.fn(),
    openPalettePage: vi.fn(),
    openHelp: vi.fn(),
    openPaste: vi.fn(),
    toggleSettings: vi.fn(),
  }

  it("drives the player for playback, audio and speed", () => {
    actionById("play-pause").run(ctx)
    expect(player.togglePlay).toHaveBeenCalledOnce()

    actionById("prev-sentence").run(ctx)
    actionById("next-sentence").run(ctx)
    expect(vi.mocked(player.jump).mock.calls).toEqual([[2], [4]]) // getSnapshot().idx is 3

    actionById("mute").run(ctx)
    expect(player.toggleMute).toHaveBeenCalledOnce()

    actionById("volume-up").run(ctx)
    actionById("volume-down").run(ctx)
    expect(vi.mocked(player.nudgeVolume).mock.calls).toEqual([[1], [-1]])

    actionById("speed-down").run(ctx)
    actionById("speed-up").run(ctx)
    expect(vi.mocked(player.nudgeSpeed).mock.calls).toEqual([[-1], [1]])
  })

  it("calls into the injected ctx for the App-level actions", () => {
    actionById("palette").run(ctx)
    actionById("settings").run(ctx)
    actionById("paste").run(ctx)
    actionById("help").run(ctx)
    expect(ctx.openPalette).toHaveBeenCalledOnce()
    expect(ctx.toggleSettings).toHaveBeenCalledOnce()
    expect(ctx.openPaste).toHaveBeenCalledOnce()
    expect(ctx.openHelp).toHaveBeenCalledOnce()

    actionById("voice").run(ctx)
    actionById("model").run(ctx)
    expect(vi.mocked(ctx.openPalettePage).mock.calls).toEqual([["voice"], ["model"]])
  })
})

describe("formatSpec", () => {
  it("swaps ⌘ for Ctrl off the Mac, and only there", () => {
    expect(formatSpec({ key: "k", mod: true }, true)).toBe("⌘K")
    expect(formatSpec({ key: "k", mod: true }, false)).toBe("Ctrl K")
    expect(formatSpec({ key: ",", mod: true }, true)).toBe("⌘,")
    expect(formatSpec({ key: ",", mod: true }, false)).toBe("Ctrl ,")
  })

  it("renders shift and the arrows as glyphs on both platforms", () => {
    expect(formatSpec({ key: "ArrowUp", shift: true }, true)).toBe("⇧↑")
    expect(formatSpec({ key: "ArrowUp", shift: true }, false)).toBe("⇧↑")
    expect(formatSpec({ key: "ArrowDown", shift: true }, true)).toBe("⇧↓")
    expect(formatSpec({ key: "ArrowLeft" }, false)).toBe("←")
    expect(formatSpec({ key: "ArrowRight" }, false)).toBe("→")
  })

  it("names the space bar and passes punctuation through untouched", () => {
    expect(formatSpec({ key: " " }, true)).toBe("space")
    expect(formatSpec({ key: " " }, false)).toBe("space")
    expect(formatSpec({ key: "[" }, true)).toBe("[")
    expect(formatSpec({ key: "]" }, false)).toBe("]")
    expect(formatSpec({ key: "?" }, true)).toBe("?")
  })

  it("uppercases a letter only under a modifier, so a bare twin never reads as shifted", () => {
    expect(formatSpec({ key: "k" }, true)).toBe("k")
    expect(formatSpec({ key: "m" }, false)).toBe("m")
    expect(formatSpec({ key: "k", mod: true }, true)).toBe("⌘K")
  })

  it("formats every headline binding in the table", () => {
    for (const action of ACTIONS) {
      expect(formatSpec(action.keys[0], true)).not.toBe("")
      expect(formatSpec(action.keys[0], false)).not.toBe("")
    }
  })
})

describe("isMac", () => {
  it("stays importable where there is no navigator at all", () => {
    vi.stubGlobal("navigator", undefined)
    expect(isMac()).toBe(false)
  })

  it("reads navigator.platform when it is populated", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "" })
    expect(isMac()).toBe(true)
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "" })
    expect(isMac()).toBe(false)
  })

  it("falls through to the user agent when platform is empty", () => {
    vi.stubGlobal("navigator", { platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
    expect(isMac()).toBe(true)
    vi.stubGlobal("navigator", { platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })
    expect(isMac()).toBe(false)
  })
})

describe("ACTIONS pairing", () => {
  const byId = new Map(ACTIONS.map((a) => [a.id, a]))

  it("points each pair at a real partner that does not pair back", () => {
    for (const a of ACTIONS) {
      if (!a.pair) continue
      const other = byId.get(a.pair.with)
      expect(other, `${a.id} pairs with a missing action`).toBeDefined()
      // Set on the first half only: two halves pairing at each other would
      // render the row twice and swallow the wrong sibling.
      expect(other?.pair).toBeUndefined()
      // The sheet renders a pair as one row inside one group heading.
      expect(other?.group).toBe(a.group)
    }
  })

  it("pairs exactly the three two-key rows", () => {
    expect(ACTIONS.filter((a) => a.pair).map((a) => a.id)).toEqual(["prev-sentence", "volume-up", "speed-down"])
  })
})
