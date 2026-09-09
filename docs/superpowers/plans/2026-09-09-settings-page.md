# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the modal Settings dialog with a page-level settings view that previews every visual preference live beside its control.

**Architecture:** A hash-backed view switch in `lib/view.ts` swaps the reader tile for a `SettingsPage` tile (rail · controls · sticky preview). Pure logic (hash parsing, stepper arithmetic, roving keyboard, section defaults, font filtering, wallpaper fit math) lives in `lib/` with node tests; sections are small components under `components/settings/` sharing a handful of controls. Prefs, theme and wallpaper hooks are unchanged; the page only reads and writes what the dialog already did.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Tailwind v4, shadcn/ui primitives (radix-ui), motion (`m.` + LazyMotion), lucide-react, sonner, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-09-09-settings-page-design.md`

## Global Constraints

- No new npm dependencies. No router: view state is `location.hash` (`#settings/<section>`).
- `ReadingPrefs`, `ThemePrefs`, storage keys and the server API do not change.
- Motion components must use `m.` from `motion/react` (the app runs `LazyMotion strict`); springs copied from the reader tile: `stiffness: 180, damping: 24`.
- Tailwind v4 utilities only; theme colours through the existing tokens and CSS vars (`--accent-base`, `--hl-bg`, `--hl-ring`, `--focus-border`, `--focus-glow`, `--progress-fill`).
- Tests: `src/**/*.test.ts` under vitest's node environment — pure functions only, no DOM.
- All commands run from the repo root `web-text-tts/` with the workspace flag, e.g. `npm test -w frontend`. Node 20 on PATH is fine (the README's `~/node22` export is stale).
- Every commit ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk
  ```
- The working tree already has unrelated uncommitted changes (README, server.py, images.py, paste/watermark files…). Stage only the files each task names — never `git add -A`.

---

## File map

| File | Responsibility |
|---|---|
| `frontend/src/lib/view.ts` (new) | `Section`, `SECTIONS`, `parseHash`, `hashFor`, `useView` — reader/settings switch backed by the URL hash and history |
| `frontend/src/lib/view.test.ts` (new) | hash round-trips |
| `frontend/src/lib/settings.ts` (new) | `stepValue`, `formatValue`, `rovingNext`, `SECTION_DEFAULTS`, `FONT_FILTERS`, `filterFonts` |
| `frontend/src/lib/settings.test.ts` (new) | tests for the above |
| `frontend/src/lib/reading.ts` | + `readerMaxWidth(width)` |
| `frontend/src/lib/wallpaper.ts` | + `wallpaperFitStyle(fit, scale?)` (moved out of App.tsx, gains miniature scaling) |
| `frontend/src/lib/reading.test.ts`, `wallpaper.test.ts` (new) | tests for the two helpers |
| `frontend/src/components/settings/controls.tsx` (new) | `SectionHeader`, `SettingRow`, `SwitchRow`, `Segmented`, `NumberField`, `useFileDrop`, `DropZone` |
| `frontend/src/components/settings/FontPicker.tsx` (new) | chip filter + radiogroup list of fonts with hover preview |
| `frontend/src/components/settings/ReadingPreview.tsx` (new) | sample paragraphs at 1:1 |
| `frontend/src/components/settings/AppMiniature.tsx` (new) | miniature of the app for Appearance / Wallpaper |
| `frontend/src/components/settings/AppearanceSection.tsx`, `ReadingSection.tsx`, `WallpaperSection.tsx`, `VoiceSection.tsx` (new) | one file per section |
| `frontend/src/components/settings/SettingsPage.tsx` (new) | tile shell: header, rail, section switch, preview slots, Escape |
| `frontend/src/App.tsx` | view state, scroll save/restore, renders page or reader |
| `frontend/src/components/TopBar.tsx` | four props, toggle button |
| `frontend/src/components/Reader.tsx` | uses `readerMaxWidth` |
| `frontend/src/components/SettingsDialog.tsx` | deleted |
| `README.md` | settings bullet |

---

### Task 1: View state (`lib/view.ts`)

**Files:**
- Create: `frontend/src/lib/view.ts`
- Test: `frontend/src/lib/view.test.ts`

**Interfaces:**
- Produces:
  - `type Section = "appearance" | "reading" | "wallpaper" | "voice"`
  - `const SECTIONS: readonly Section[]`
  - `type ViewState = { view: "reader" } | { view: "settings"; section: Section }`
  - `parseHash(hash: string): ViewState`
  - `hashFor(state: ViewState): string`
  - `useView(): { state: ViewState; openSettings: (section?: Section) => void; setSection: (s: Section) => void; closeSettings: () => void }`

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/view.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w frontend -- src/lib/view.test.ts`
Expected: FAIL — `Failed to resolve import "./view"`.

- [ ] **Step 3: Implement `view.ts`**

```ts
import { useCallback, useEffect, useState } from "react"

export type Section = "appearance" | "reading" | "wallpaper" | "voice"
export const SECTIONS: readonly Section[] = ["appearance", "reading", "wallpaper", "voice"]

export type ViewState = { view: "reader" } | { view: "settings"; section: Section }

const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s)

/** `#settings` or `#settings/<section>` opens the page; anything else is the reader. */
export function parseHash(hash: string): ViewState {
  const [head, tail = ""] = hash.replace(/^#/, "").split("/")
  if (head !== "settings") return { view: "reader" }
  return { view: "settings", section: isSection(tail) ? tail : "appearance" }
}

export function hashFor(state: ViewState): string {
  return state.view === "settings" ? `#settings/${state.section}` : ""
}

// Remembered for the session so reopening lands on the last section visited.
let lastSection: Section = "appearance"

/**
 * Reader / settings switch backed by the URL hash. Opening pushes one history
 * entry (so the browser back button closes the page); switching sections
 * replaces it (so back still returns to the reader in one step); closing pops
 * that entry when it is ours, or just clears the hash when the page was
 * loaded on `#settings` directly.
 */
export function useView() {
  const [state, setState] = useState<ViewState>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onPop = () => setState(parseHash(window.location.hash))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const openSettings = useCallback((section: Section = lastSection) => {
    lastSection = section
    const next: ViewState = { view: "settings", section }
    window.history.pushState({ settings: true }, "", hashFor(next))
    setState(next)
  }, [])

  const setSection = useCallback((section: Section) => {
    lastSection = section
    const next: ViewState = { view: "settings", section }
    window.history.replaceState({ settings: true }, "", hashFor(next))
    setState(next)
  }, [])

  const closeSettings = useCallback(() => {
    if ((window.history.state as { settings?: boolean } | null)?.settings) {
      window.history.back() // popstate flips the view
      return
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search)
    setState({ view: "reader" })
  }, [])

  return { state, openSettings, setSection, closeSettings }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w frontend -- src/lib/view.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/view.ts frontend/src/lib/view.test.ts
git commit -m "feat(settings): hash-backed reader/settings view state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 2: Settings helpers (`lib/settings.ts`)

**Files:**
- Create: `frontend/src/lib/settings.ts`
- Test: `frontend/src/lib/settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PREFS`, `FONT_GROUPS`, `FontKey`, `ReadingPrefs` from `@/lib/reading`.
- Produces:
  - `stepValue(value: number, step: number, direction: 1 | -1, min: number, max: number): number`
  - `formatValue(value: number, step: number): string`
  - `rovingNext<K>(keys: readonly K[], current: K, key: string): K | null`
  - `type ResettableSection = "appearance" | "reading" | "wallpaper"`
  - `SECTION_DEFAULTS: Record<ResettableSection, Partial<ReadingPrefs>>`
  - `FONT_FILTERS: string[]` (`"All"` first, then the group labels)
  - `filterFonts(filter: string): { label: string; fonts: FontKey[] }[]`

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/settings.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w frontend -- src/lib/settings.test.ts`
Expected: FAIL — `Failed to resolve import "./settings"`.

- [ ] **Step 3: Implement `settings.ts`**

```ts
import { DEFAULT_PREFS, FONT_GROUPS, type FontKey, type ReadingPrefs } from "./reading"

const stepDecimals = (step: number) => (String(step).split(".")[1] ?? "").length

/** Step a numeric pref one increment, snapped to the step grid, clamped, and
 *  rounded to the step's precision so 1.75 + 0.05 never renders as 1.8000000001. */
export function stepValue(value: number, step: number, direction: 1 | -1, min: number, max: number): number {
  const snapped = Math.round((value + direction * step) / step) * step
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(stepDecimals(step)))
}

export const formatValue = (value: number, step: number): string => value.toFixed(stepDecimals(step))

/** Arrow / Home / End navigation for a radiogroup with a roving tab stop:
 *  the key to move to, or null when `key` isn't a navigation key. A current
 *  key that isn't in the list (filtered out) starts from the first item. */
export function rovingNext<K>(keys: readonly K[], current: K, key: string): K | null {
  const n = keys.length
  if (n === 0) return null
  const i = keys.indexOf(current) // -1 when the current key is filtered out
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return i < 0 ? keys[0] : keys[(i + 1) % n]
    case "ArrowUp":
    case "ArrowLeft":
      return i < 0 ? keys[n - 1] : keys[(i - 1 + n) % n]
    case "Home":
      return keys[0]
    case "End":
      return keys[n - 1]
    default:
      return null
  }
}

export type ResettableSection = "appearance" | "reading" | "wallpaper"

/** What each section's Reset restores. Together they cover every ReadingPrefs
 *  key exactly once (theme prefs reset through useTheme().reset). */
export const SECTION_DEFAULTS: Record<ResettableSection, Partial<ReadingPrefs>> = {
  appearance: { uiScale: DEFAULT_PREFS.uiScale, showClock: DEFAULT_PREFS.showClock },
  reading: {
    font: DEFAULT_PREFS.font,
    size: DEFAULT_PREFS.size,
    lineHeight: DEFAULT_PREFS.lineHeight,
    paraSpacing: DEFAULT_PREFS.paraSpacing,
    width: DEFAULT_PREFS.width,
    justify: DEFAULT_PREFS.justify,
    autoScroll: DEFAULT_PREFS.autoScroll,
  },
  wallpaper: {
    wallpaperFit: DEFAULT_PREFS.wallpaperFit,
    wallpaperPos: DEFAULT_PREFS.wallpaperPos,
    wallpaperOpacity: DEFAULT_PREFS.wallpaperOpacity,
  },
}

export const FONT_FILTERS: string[] = ["All", ...FONT_GROUPS.map((g) => g.label)]

export function filterFonts(filter: string): { label: string; fonts: FontKey[] }[] {
  const group = FONT_GROUPS.filter((g) => g.label === filter)
  return group.length ? group : FONT_GROUPS
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w frontend -- src/lib/settings.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/settings.ts frontend/src/lib/settings.test.ts
git commit -m "feat(settings): stepper, roving-focus, section-default and font-filter helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 3: Shared geometry — `readerMaxWidth` and `wallpaperFitStyle`

**Files:**
- Modify: `frontend/src/lib/reading.ts` (append after `DEFAULT_PREFS`)
- Modify: `frontend/src/lib/wallpaper.ts` (append after `wallpaperUrl`)
- Modify: `frontend/src/components/Reader.tsx:8,98`
- Modify: `frontend/src/App.tsx:9-20,74-83`
- Test: `frontend/src/lib/reading.test.ts`, `frontend/src/lib/wallpaper.test.ts`

**Interfaces:**
- Produces:
  - `readerMaxWidth(width: number): number` in `@/lib/reading` — px cap of the reader column.
  - `wallpaperFitStyle(fit: WallpaperFit, scale?: { w: number; h: number; ratio: number }): CSSProperties` in `@/lib/wallpaper`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/reading.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { readerMaxWidth } from "./reading"

describe("readerMaxWidth", () => {
  it("is 16px per unit plus the tile's padding allowance", () => {
    expect(readerMaxWidth(44)).toBe(800)
    expect(readerMaxWidth(34)).toBe(640)
    expect(readerMaxWidth(60)).toBe(1056)
  })
})
```

`frontend/src/lib/wallpaper.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { wallpaperFitStyle } from "./wallpaper"

describe("wallpaperFitStyle", () => {
  it("maps the relative fits straight to background-size", () => {
    expect(wallpaperFitStyle("cover")).toEqual({ backgroundSize: "cover", backgroundRepeat: "no-repeat" })
    expect(wallpaperFitStyle("contain")).toEqual({ backgroundSize: "contain", backgroundRepeat: "no-repeat" })
    expect(wallpaperFitStyle("stretch")).toEqual({ backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" })
  })

  it("uses the image's natural size for tile and center at full scale", () => {
    expect(wallpaperFitStyle("tile")).toEqual({ backgroundSize: "auto", backgroundRepeat: "repeat" })
    expect(wallpaperFitStyle("center")).toEqual({ backgroundSize: "auto", backgroundRepeat: "no-repeat" })
  })

  it("scales the natural size for a miniature", () => {
    const scale = { w: 1920, h: 1080, ratio: 0.25 }
    expect(wallpaperFitStyle("tile", scale)).toEqual({ backgroundSize: "480px 270px", backgroundRepeat: "repeat" })
    expect(wallpaperFitStyle("center", scale)).toEqual({ backgroundSize: "480px 270px", backgroundRepeat: "no-repeat" })
    // relative fits ignore the scale
    expect(wallpaperFitStyle("cover", scale)).toEqual({ backgroundSize: "cover", backgroundRepeat: "no-repeat" })
  })

  it("never collapses a scaled image below 1px", () => {
    expect(wallpaperFitStyle("tile", { w: 10, h: 10, ratio: 0.01 })).toEqual({ backgroundSize: "1px 1px", backgroundRepeat: "repeat" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w frontend -- src/lib/reading.test.ts src/lib/wallpaper.test.ts`
Expected: FAIL — `readerMaxWidth` / `wallpaperFitStyle` not exported.

- [ ] **Step 3: Add `readerMaxWidth` to `reading.ts`**

Append after the `DEFAULT_PREFS` block:

```ts
/** Reader column cap in px for a Text width pref: 16px per unit plus a
 *  6-unit allowance for the tile's horizontal padding. The settings preview
 *  caption quotes the same figure. */
export const readerMaxWidth = (width: number): number => (width + 6) * 16
```

- [ ] **Step 4: Add `wallpaperFitStyle` to `wallpaper.ts`**

Change the first import line to `import { useCallback, useEffect, useState, type CSSProperties } from "react"` and append after `wallpaperUrl`:

```ts
/** background-size / -repeat for a wallpaper fit. `cover`, `contain` and
 *  `stretch` are relative to their box; `tile` and `center` use the image's
 *  natural size, which `scale` shrinks for the settings miniature
 *  (ratio = miniature width / viewport width). */
export function wallpaperFitStyle(fit: WallpaperFit, scale?: { w: number; h: number; ratio: number }): CSSProperties {
  const natural = scale
    ? `${Math.max(1, Math.round(scale.w * scale.ratio))}px ${Math.max(1, Math.round(scale.h * scale.ratio))}px`
    : "auto"
  switch (fit) {
    case "cover":
      return { backgroundSize: "cover", backgroundRepeat: "no-repeat" }
    case "contain":
      return { backgroundSize: "contain", backgroundRepeat: "no-repeat" }
    case "stretch":
      return { backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" }
    case "tile":
      return { backgroundSize: natural, backgroundRepeat: "repeat" }
    case "center":
      return { backgroundSize: natural, backgroundRepeat: "no-repeat" }
  }
}
```

Add `import type { WallpaperFit } from "./reading"` at the top of `wallpaper.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w frontend -- src/lib/reading.test.ts src/lib/wallpaper.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Use the helpers in Reader and App**

`Reader.tsx`: change the import to `import { FONT_STACKS, readerMaxWidth, type ReadingPrefs } from "@/lib/reading"` and the tile style to

```tsx
style={{ maxWidth: `min(100%, ${readerMaxWidth(prefs.width)}px)` }}
```

`App.tsx`: delete the `WALLPAPER_FIT_STYLES` constant and the `CSSProperties` / `WallpaperFit` imports it needed; import `wallpaperFitStyle` from `@/lib/wallpaper` alongside `useWallpaper, wallpaperUrl`; in the wallpaper layer replace `...WALLPAPER_FIT_STYLES[prefs.wallpaperFit]` with `...wallpaperFitStyle(prefs.wallpaperFit)`. The `useReadingPrefs` import becomes `import { useReadingPrefs } from "@/lib/reading"`.

- [ ] **Step 7: Type-check and run the whole suite**

Run: `npm run build -w frontend && npm test -w frontend`
Expected: build succeeds (it emits into `static/` — that is expected and those files are tracked; do not commit `static/` in this task), all tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/reading.ts frontend/src/lib/reading.test.ts frontend/src/lib/wallpaper.ts frontend/src/lib/wallpaper.test.ts frontend/src/components/Reader.tsx frontend/src/App.tsx
git commit -m "refactor: share reader column width and wallpaper fit math

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 4: Shared settings controls

**Files:**
- Create: `frontend/src/components/settings/controls.tsx`

**Interfaces:**
- Consumes: `stepValue`, `formatValue` from `@/lib/settings`; `Button`, `Label`, `Slider`, `Switch` from `@/components/ui/*`.
- Produces (all named exports):
  - `SectionHeader({ title, description, onReset? })`
  - `SettingRow({ label, description?, htmlFor?, inline?, children })`
  - `SwitchRow({ id, label, description?, checked, onChange })`
  - `Segmented<K extends string>({ label, value, options: { key: K; label: string; Icon?: LucideIcon }[], onChange, className? })`
  - `NumberField({ label, description?, value, min, max, step, unit?, onChange })`
  - `useFileDrop(onFile: (f: File) => void): { dragging: boolean; dropProps: {...} }`
  - `DropZone({ Icon, label, hint, accept, onFile, className? })`

- [ ] **Step 1: Write `controls.tsx`**

```tsx
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import { Minus, Plus, RotateCcw, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { formatValue, rovingNext, stepValue } from "@/lib/settings"
import { cn } from "@/lib/utils"

export function SectionHeader({ title, description, onReset }: { title: string; description: string; onReset?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {onReset && (
        <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" onClick={onReset}>
          <RotateCcw aria-hidden />
          Reset
        </Button>
      )}
    </div>
  )
}

/** Label + optional description, with the control inline on the right
 *  (`inline`, for switches and segments) or below at full width. */
export function SettingRow({
  label,
  description,
  htmlFor,
  inline,
  children,
}: {
  label: string
  description?: string
  htmlFor?: string
  inline?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn(inline ? "flex items-center justify-between gap-6" : "space-y-2.5")}>
      <div className="space-y-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

export function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <SettingRow label={label} description={description} htmlFor={id} inline>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  )
}

/** Joined radio group: arrow keys move the selection, one roving tab stop. */
export function Segmented<K extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: K
  options: { key: K; label: string; Icon?: LucideIcon }[]
  onChange: (k: K) => void
  className?: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingNext(options.map((o) => o.key), value, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex w-full flex-wrap gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      {options.map(({ key, label: text, Icon }) => {
        const active = key === value
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            data-key={key}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[min(var(--radius-md),12px)] px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-3.5" aria-hidden />}
            {text}
          </button>
        )
      })}
    </div>
  )
}

/** Label, `[−] value [+]` stepper on the right, slider underneath. Works in
 *  display units — callers convert (e.g. uiScale 1.0 ↔ 100). */
export function NumberField({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
}) {
  const bump = (dir: 1 | -1) => onChange(stepValue(value, step, dir, min, max))
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <span className="text-sm font-medium">{label}</span>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" onClick={() => bump(-1)} disabled={value <= min} aria-label={`Decrease ${label}`}>
            <Minus aria-hidden />
          </Button>
          <span className="min-w-14 text-center font-mono text-xs tabular-nums">
            {formatValue(value, step)}
            {unit ? ` ${unit}` : ""}
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => bump(1)} disabled={value >= max} aria-label={`Increase ${label}`}>
            <Plus aria-hidden />
          </Button>
        </div>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} aria-label={label} />
    </div>
  )
}

/** Drag-and-drop file handling for any element: spread `dropProps` on it. */
export function useFileDrop(onFile: (f: File) => void) {
  const [dragging, setDragging] = useState(false)
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      setDragging(false)
      const f = e.dataTransfer.files[0]
      if (f) onFile(f)
    },
  }
  return { dragging, dropProps }
}

/** Dashed click-or-drop target wrapping a hidden file input. */
export function DropZone({
  Icon,
  label,
  hint,
  accept,
  onFile,
  className,
}: {
  Icon: LucideIcon
  label: string
  hint: string
  accept: string
  onFile: (f: File) => void
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { dragging, dropProps } = useFileDrop(onFile)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) onFile(f)
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        data-dragging={dragging || undefined}
        {...dropProps}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50 data-dragging:border-ring data-dragging:bg-accent",
          className,
        )}
      >
        <Icon className="size-5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>
    </>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npx -w frontend tsc -b` (or `cd frontend && npx tsc -b` if npx ignores the workspace flag)
Expected: no errors. (`noUnusedLocals` is on: every import above is used.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/settings/controls.tsx
git commit -m "feat(settings): shared page controls (rows, segmented, stepper, drop zone)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 5: Reading — preview, font picker, section

**Files:**
- Create: `frontend/src/components/settings/ReadingPreview.tsx`
- Create: `frontend/src/components/settings/FontPicker.tsx`
- Create: `frontend/src/components/settings/ReadingSection.tsx`

**Interfaces:**
- Consumes: `FONT_GROUPS`-driven `filterFonts`, `FONT_FILTERS`, `rovingNext`, `SECTION_DEFAULTS` from `@/lib/settings`; `FONT_HINTS`, `FONT_LABELS`, `FONT_STACKS`, `readerMaxWidth`, `FontKey`, `ReadingPrefs` from `@/lib/reading`; `NumberField`, `SectionHeader`, `SettingRow`, `SwitchRow` from `./controls`.
- Produces:
  - `ReadingPreview({ prefs: ReadingPrefs; hoverFont: FontKey | null })`
  - `FontPicker({ value: FontKey; onChange: (f: FontKey) => void; onHover: (f: FontKey | null) => void })`
  - `ReadingSection({ prefs: ReadingPrefs; update: (patch: Partial<ReadingPrefs>) => void; onHoverFont: (f: FontKey | null) => void })`

- [ ] **Step 1: Write `ReadingPreview.tsx`**

```tsx
import { FONT_LABELS, FONT_STACKS, readerMaxWidth, type FontKey, type ReadingPrefs } from "@/lib/reading"

/** Two sample paragraphs set exactly as the reader would set them. While a
 *  font row is hovered or focused it shows that face instead of the saved one. */
export function ReadingPreview({ prefs, hoverFont }: { prefs: ReadingPrefs; hoverFont: FontKey | null }) {
  const font = hoverFont ?? prefs.font
  const caption = hoverFont
    ? `${FONT_LABELS[hoverFont]} — click to use`
    : `${FONT_LABELS[prefs.font]} · ${prefs.size} px · ${prefs.lineHeight.toFixed(2)} · ≈ ${readerMaxWidth(prefs.width)} px column`

  return (
    <div className="space-y-2">
      <div
        aria-hidden
        className="relative max-h-40 overflow-hidden rounded-lg border bg-card/85 px-5 py-4 [mask-image:linear-gradient(to_bottom,black_65%,transparent)] md:max-h-none md:[mask-image:none]"
        style={{
          fontFamily: FONT_STACKS[font],
          fontSize: `${prefs.size}px`,
          lineHeight: prefs.lineHeight,
          textAlign: prefs.justify ? "justify" : undefined,
        }}
      >
        <p style={{ marginBottom: `${prefs.paraSpacing}em` }}>
          The rain had stopped by the time she reached the station, though the platform still shone under the lamps. She
          counted the carriages as they slid past — seven, eight — and only then let herself breathe.
        </p>
        <p>
          <span className="hl-current rounded-sm box-decoration-clone px-0.5">
            “You’re late,” said the man in the grey coat, not unkindly.
          </span>{" "}
          <em>So are you</em>, she thought, and said nothing.
        </p>
      </div>
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
        {caption}
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Write `FontPicker.tsx`**

```tsx
import { useState, type KeyboardEvent } from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FONT_HINTS, FONT_LABELS, FONT_STACKS, type FontKey } from "@/lib/reading"
import { FONT_FILTERS, filterFonts, rovingNext } from "@/lib/settings"
import { cn } from "@/lib/utils"

interface Props {
  value: FontKey
  onChange: (f: FontKey) => void
  /** Pointer or keyboard focus on a row previews it; null clears. */
  onHover: (f: FontKey | null) => void
}

/** Chip-filtered list of the reading fonts, each row set in its own face.
 *  A radiogroup: arrow keys move (and commit) the selection. */
export function FontPicker({ value, onChange, onHover }: Props) {
  const [filter, setFilter] = useState("All")
  const groups = filterFonts(filter)
  const visible = groups.flatMap((g) => g.fonts)
  // One roving tab stop: the selected font when it is visible, else the first row.
  const tabStop = visible.includes(value) ? value : visible[0]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingNext(visible, value, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-font="${next}"]`)?.focus()
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Font category">
        {FONT_FILTERS.map((f) => (
          <Button key={f} variant={filter === f ? "secondary" : "ghost"} size="xs" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </Button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label="Reading font"
        onKeyDown={onKeyDown}
        onPointerLeave={() => onHover(null)}
        className="overflow-hidden rounded-md border"
      >
        {groups.map(({ label, fonts }) => (
          <div key={label}>
            {filter === "All" && (
              <div className="px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
            )}
            {fonts.map((k) => {
              const selected = k === value
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-font={k}
                  tabIndex={k === tabStop ? 0 : -1}
                  onClick={() => onChange(k)}
                  onPointerEnter={() => onHover(k)}
                  onFocus={() => onHover(k)}
                  onBlur={() => onHover(null)}
                  className={cn(
                    "flex w-full cursor-pointer items-baseline justify-between gap-4 px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent",
                    selected && "bg-secondary",
                  )}
                >
                  <span className="text-[17px] leading-6" style={{ fontFamily: FONT_STACKS[k] }}>
                    {FONT_LABELS[k]}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {FONT_HINTS[k]}
                    <Check className={cn("size-3.5", selected ? "text-foreground" : "invisible")} aria-hidden />
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Write `ReadingSection.tsx`**

```tsx
import type { FontKey, ReadingPrefs } from "@/lib/reading"
import { SECTION_DEFAULTS } from "@/lib/settings"
import { FontPicker } from "./FontPicker"
import { NumberField, SectionHeader, SettingRow, SwitchRow } from "./controls"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  onHoverFont: (f: FontKey | null) => void
}

export function ReadingSection({ prefs, update, onHoverFont }: Props) {
  return (
    <>
      <SectionHeader title="Reading" description="How chapter text is set. The preview follows every change." onReset={() => update(SECTION_DEFAULTS.reading)} />
      <SettingRow label="Font">
        <FontPicker value={prefs.font} onChange={(font) => update({ font })} onHover={onHoverFont} />
      </SettingRow>
      <NumberField label="Size" value={prefs.size} min={14} max={26} step={1} unit="px" onChange={(size) => update({ size })} />
      <NumberField label="Line spacing" value={prefs.lineHeight} min={1.3} max={2.4} step={0.05} onChange={(lineHeight) => update({ lineHeight })} />
      <NumberField label="Paragraph spacing" value={prefs.paraSpacing} min={0.4} max={2.4} step={0.1} unit="em" onChange={(paraSpacing) => update({ paraSpacing })} />
      <NumberField
        label="Text width"
        description="How wide the column may grow. The preview caption shows it in pixels."
        value={prefs.width}
        min={34}
        max={60}
        step={1}
        onChange={(width) => update({ width })}
      />
      <SwitchRow id="pref-justify" label="Justify text" description="Straight right edge, like a printed book." checked={prefs.justify} onChange={(justify) => update({ justify })} />
      <SwitchRow id="pref-autoscroll" label="Auto-scroll" description="Keep the sentence being read in view." checked={prefs.autoScroll} onChange={(autoScroll) => update({ autoScroll })} />
    </>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx -w frontend tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/settings/ReadingPreview.tsx frontend/src/components/settings/FontPicker.tsx frontend/src/components/settings/ReadingSection.tsx
git commit -m "feat(settings): reading section with live preview and font list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 6: Appearance and Wallpaper — miniature and sections

**Files:**
- Create: `frontend/src/components/settings/AppMiniature.tsx`
- Create: `frontend/src/components/settings/AppearanceSection.tsx`
- Create: `frontend/src/components/settings/WallpaperSection.tsx`

**Interfaces:**
- Consumes: `wallpaperFitStyle`, `wallpaperUrl`, `WallpaperInfo` from `@/lib/wallpaper`; `WALLPAPER_FIT_LABELS`, `WALLPAPER_POS_X`, `WALLPAPER_POS_Y`, `WallpaperFit`, `ReadingPrefs` from `@/lib/reading`; `ACCENT_LABELS`, `ACCENT_SWATCHES`, `SCHEME_LABELS`, `SCHEME_PREVIEWS`, `AccentKey`, `SchemeKey`, `ThemeMode`, `ThemePrefs` from `@/lib/theme`; `SECTION_DEFAULTS` from `@/lib/settings`; controls from `./controls`.
- Produces:
  - `AppMiniature({ prefs, theme, dark, wallpaper, caption: "appearance" | "wallpaper" })`
  - `AppearanceSection({ prefs, update, theme, dark, updateTheme, resetTheme })`
  - `WallpaperSection({ prefs, update, wallpaper, uploadWallpaper, removeWallpaper })`

- [ ] **Step 1: Write `AppMiniature.tsx`**

```tsx
import { useEffect, useRef, useState } from "react"
import { WALLPAPER_FIT_LABELS, type ReadingPrefs } from "@/lib/reading"
import { ACCENT_LABELS, SCHEME_LABELS, type ThemePrefs } from "@/lib/theme"
import { wallpaperFitStyle, wallpaperUrl, type WallpaperInfo } from "@/lib/wallpaper"

interface Props {
  prefs: ReadingPrefs
  theme: ThemePrefs
  dark: boolean
  wallpaper: WallpaperInfo | null
  caption: "appearance" | "wallpaper"
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

const LINES = ["92%", "80%", "60%", null, "88%", "40%"] // null = the current sentence

/** The app drawn in miniature from CSS variables alone, so it follows scheme,
 *  mode, accent and wallpaper live. No text: bars stand in for lines. */
export function AppMiniature({ prefs, theme, dark, wallpaper, caption }: Props) {
  const { ref, width } = useWidth()
  const ratio = width > 0 ? width / window.innerWidth : 0
  const text =
    caption === "appearance"
      ? `${SCHEME_LABELS[theme.scheme]} · ${dark ? "Dark" : "Light"} · ${ACCENT_LABELS[theme.accent]}`
      : wallpaper
        ? `${WALLPAPER_FIT_LABELS[prefs.wallpaperFit]} · ${prefs.wallpaperPos} · ${Math.round(prefs.wallpaperOpacity * 100)} %`
        : "No wallpaper"

  return (
    <div className="space-y-2">
      <div ref={ref} aria-hidden className="relative aspect-[16/10] overflow-hidden rounded-lg border bg-background">
        {wallpaper && ratio > 0 && (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url("${wallpaperUrl(wallpaper)}")`,
              backgroundPosition: prefs.wallpaperPos,
              opacity: prefs.wallpaperOpacity,
              ...wallpaperFitStyle(prefs.wallpaperFit, { w: wallpaper.w, h: wallpaper.h, ratio }),
            }}
          />
        )}
        {/* top bar */}
        <div className="absolute inset-x-[4%] top-[4%] flex h-[9%] items-center gap-[2%] rounded-[3px] border bg-card/80 px-[2.5%]">
          <span className="aspect-square w-[2.2%] rounded-[1px] bg-(--accent-base)" />
          <span className="h-[3px] w-[16%] rounded-full bg-foreground/60" />
          <span className="ml-auto h-[45%] w-[12%] rounded-[2px] bg-primary" />
        </div>
        {/* reader tile — the focused window while the voice reads */}
        <div className="absolute inset-x-[16%] top-[17%] bottom-[19%] rounded-[4px] border border-(--focus-border) bg-card/85 px-[5%] py-[5%] shadow-[0_0_18px_-4px_var(--focus-glow)]">
          <div className="flex flex-col gap-[6%]">
            {LINES.map((w, i) =>
              w === null ? (
                <span
                  key={i}
                  className="block h-[5px] w-[75%] rounded-[2px]"
                  style={{ background: "var(--hl-bg)", boxShadow: "0 0 0 1px var(--hl-ring)" }}
                />
              ) : (
                <span key={i} className="block h-[3px] rounded-full bg-foreground/15" style={{ width: w }} />
              ),
            )}
          </div>
        </div>
        {/* player bar */}
        <div className="absolute inset-x-[4%] bottom-[4%] h-[11%] overflow-hidden rounded-[3px] border bg-card/85">
          <div className="h-[2px] w-[40%] bg-(--progress-fill)" />
          <span className="absolute top-1/2 left-1/2 aspect-square w-[5%] -translate-x-1/2 -translate-y-1/2 rounded-[2px] bg-primary" />
        </div>
      </div>
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">{text}</p>
    </div>
  )
}
```

`gap-[6%]` inside a column flex resolves against the container height, which is what we want for line rhythm.

- [ ] **Step 2: Write `AppearanceSection.tsx`**

```tsx
import { Monitor, Moon, Sun } from "lucide-react"
import type { ReadingPrefs } from "@/lib/reading"
import { SECTION_DEFAULTS } from "@/lib/settings"
import {
  ACCENT_LABELS,
  ACCENT_SWATCHES,
  SCHEME_LABELS,
  SCHEME_PREVIEWS,
  type AccentKey,
  type SchemeKey,
  type ThemeMode,
  type ThemePrefs,
} from "@/lib/theme"
import { cn } from "@/lib/utils"
import { NumberField, SectionHeader, Segmented, SettingRow, SwitchRow } from "./controls"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  theme: ThemePrefs
  dark: boolean
  updateTheme: (patch: Partial<ThemePrefs>) => void
  resetTheme: () => void
}

const THEME_MODES: { key: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { key: "light", label: "Light", Icon: Sun },
  { key: "dark", label: "Dark", Icon: Moon },
  { key: "system", label: "System", Icon: Monitor },
]

/** The five accent hues a scheme ships with. */
function PaletteDots({ colors }: { colors: string[] }) {
  return (
    <span aria-hidden className="flex items-center gap-1">
      {colors.map((c, i) => (
        <span key={i} className="size-2 rounded-full" style={{ background: c }} />
      ))}
    </span>
  )
}

export function AppearanceSection({ prefs, update, theme, dark, updateTheme, resetTheme }: Props) {
  const previewMode = dark ? "dark" : "light"
  return (
    <>
      <SectionHeader
        title="Appearance"
        description="Theme, palette and the size of the chrome."
        onReset={() => {
          resetTheme()
          update(SECTION_DEFAULTS.appearance)
        }}
      />
      <SettingRow label="Theme">
        <Segmented label="Theme" value={theme.mode} options={THEME_MODES} onChange={(mode) => updateTheme({ mode })} />
      </SettingRow>
      <SettingRow label="Palette" description="Terminal colour schemes; each brings its own accent hues.">
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(SCHEME_LABELS) as SchemeKey[]).map((k) => {
            const active = theme.scheme === k
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => updateTheme({ scheme: k })}
                className={cn(
                  "flex cursor-pointer flex-col items-start gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "border-ring bg-secondary" : "border-border",
                )}
              >
                <span className="text-sm">{SCHEME_LABELS[k]}</span>
                <PaletteDots colors={SCHEME_PREVIEWS[k][previewMode]} />
              </button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow label="Accent" description="Sentence highlight, focused-window glow and progress.">
        <div className="flex items-center gap-2.5">
          {(Object.keys(ACCENT_LABELS) as AccentKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => updateTheme({ accent: k })}
              title={ACCENT_LABELS[k]}
              aria-label={`${ACCENT_LABELS[k]} accent`}
              aria-pressed={theme.accent === k}
              className={cn(
                "size-7 cursor-pointer rounded-full border border-black/20 transition-[transform,box-shadow] duration-200 outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95 dark:border-white/20",
                theme.accent === k && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ background: ACCENT_SWATCHES[k] }}
            />
          ))}
          <span className="ml-1 text-xs text-muted-foreground">{ACCENT_LABELS[theme.accent]}</span>
        </div>
      </SettingRow>
      <NumberField
        label="UI scale"
        description="Bars, controls and this page. Reading text keeps its own size."
        value={Math.round(prefs.uiScale * 100)}
        min={85}
        max={150}
        step={5}
        unit="%"
        onChange={(v) => update({ uiScale: v / 100 })}
      />
      <SwitchRow id="pref-clock" label="Show clock" description="In the top bar." checked={prefs.showClock} onChange={(showClock) => update({ showClock })} />
    </>
  )
}
```

- [ ] **Step 3: Write `WallpaperSection.tsx`**

```tsx
import { useRef } from "react"
import { ImagePlus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  WALLPAPER_FIT_LABELS,
  WALLPAPER_POS_X,
  WALLPAPER_POS_Y,
  type ReadingPrefs,
  type WallpaperFit,
} from "@/lib/reading"
import { SECTION_DEFAULTS } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { wallpaperUrl, type WallpaperInfo } from "@/lib/wallpaper"
import { DropZone, NumberField, SectionHeader, Segmented, SettingRow, useFileDrop } from "./controls"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  wallpaper: WallpaperInfo | null
  uploadWallpaper: (file: Blob) => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp"
const HINT = "png, jpeg, gif or webp up to 200 MB"

const FITS = (Object.keys(WALLPAPER_FIT_LABELS) as WallpaperFit[]).map((key) => ({ key, label: WALLPAPER_FIT_LABELS[key] }))

export function WallpaperSection({ prefs, update, wallpaper, uploadWallpaper, removeWallpaper }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (file: File) => {
    if (!(await uploadWallpaper(file))) toast.error(`Wallpaper upload failed — ${HINT}`)
  }
  const onRemove = async () => {
    if (!(await removeWallpaper())) toast.error("Couldn't remove wallpaper — is the server running?")
  }
  const { dragging, dropProps } = useFileDrop((f) => void onFile(f))

  return (
    <>
      <SectionHeader
        title="Wallpaper"
        description="A picture behind the tiles. Reset restores the layout and keeps the image."
        onReset={wallpaper ? () => update(SECTION_DEFAULTS.wallpaper) : undefined}
      />
      {wallpaper ? (
        <SettingRow label="Image" description="Drop a new picture on the thumbnail to replace it.">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ""
              if (f) void onFile(f)
            }}
          />
          <div className="flex items-center gap-4" {...dropProps}>
            <img
              src={wallpaperUrl(wallpaper)}
              alt=""
              className={cn("aspect-video w-40 shrink-0 rounded-md border object-cover transition-colors", dragging && "border-ring")}
            />
            <div className="flex flex-col items-start gap-1.5">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <ImagePlus aria-hidden />
                Replace image
              </Button>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void onRemove()}>
                <Trash2 aria-hidden />
                Remove
              </Button>
            </div>
          </div>
        </SettingRow>
      ) : (
        <DropZone Icon={ImagePlus} label="Choose image" hint={HINT} accept={ACCEPT} onFile={(f) => void onFile(f)} />
      )}
      {wallpaper && (
        <>
          <SettingRow label="Fit">
            <Segmented label="Wallpaper fit" value={prefs.wallpaperFit} options={FITS} onChange={(wallpaperFit) => update({ wallpaperFit })} />
          </SettingRow>
          <SettingRow
            label="Position"
            description={prefs.wallpaperFit === "stretch" ? "Stretch fills the screen, so position has no effect." : undefined}
            inline
          >
            <div
              role="group"
              aria-label="Wallpaper position"
              className={cn("grid w-fit grid-cols-3 gap-1", prefs.wallpaperFit === "stretch" && "pointer-events-none opacity-40")}
            >
              {WALLPAPER_POS_Y.map((y) =>
                WALLPAPER_POS_X.map((x) => {
                  const val = `${x} ${y}`
                  const active = prefs.wallpaperPos === val
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => update({ wallpaperPos: val })}
                      title={val}
                      aria-label={`Align ${val}`}
                      aria-pressed={active}
                      className={cn(
                        "grid size-6 cursor-pointer place-items-center rounded-sm border transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                        active ? "border-ring bg-secondary" : "border-border",
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", active ? "bg-foreground" : "bg-muted-foreground/40")} />
                    </button>
                  )
                }),
              )}
            </div>
          </SettingRow>
          <NumberField
            label="Opacity"
            value={Math.round(prefs.wallpaperOpacity * 100)}
            min={5}
            max={100}
            step={5}
            unit="%"
            onChange={(v) => update({ wallpaperOpacity: v / 100 })}
          />
        </>
      )}
    </>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx -w frontend tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/settings/AppMiniature.tsx frontend/src/components/settings/AppearanceSection.tsx frontend/src/components/settings/WallpaperSection.tsx
git commit -m "feat(settings): appearance and wallpaper sections with an app miniature

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 7: Voice section

**Files:**
- Create: `frontend/src/components/settings/VoiceSection.tsx`

**Interfaces:**
- Consumes: `usePlayer`, `player` from `@/lib/player`; `uploadClone` from `@/lib/api`; `VoiceCombobox`, `EngineModeList`; `DropZone`, `SectionHeader`, `SettingRow` from `./controls`; `Input` from `@/components/ui/input`.
- Produces: `VoiceSection()` (no props — it reads the player store).

- [ ] **Step 1: Write `VoiceSection.tsx`**

```tsx
import { FileAudio } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { EngineModeList } from "@/components/EngineModePicker"
import { VoiceCombobox } from "@/components/VoiceCombobox"
import { uploadClone } from "@/lib/api"
import { player, usePlayer } from "@/lib/player"
import { DropZone, SectionHeader, SettingRow } from "./controls"

export function VoiceSection() {
  const { voice, voices, engine, instruct } = usePlayer()
  const isQwen3 = engine?.engine === "qwen3"

  const onClone = async (f: File) => {
    const name = f.name.replace(/\.[^.]+$/, "")
    try {
      await uploadClone(name, await f.arrayBuffer())
      await player.refreshVoices()
      toast.success(`Voice "${name}" added`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    }
  }

  return (
    <>
      <SectionHeader title="Voice" description="Who reads, and on which hardware." />
      <SettingRow label="Narrator" description="Grouped by engine and language. Cloned voices appear under Cloned.">
        <VoiceCombobox voice={voice} voices={voices} className="w-full" />
      </SettingRow>
      <EngineModeList engine={engine} />
      {isQwen3 && (
        <>
          <SettingRow label="Style instruction" description="Applies to preset voices. Changing it regenerates audio." htmlFor="instruct">
            <Input
              id="instruct"
              placeholder='e.g. "read calmly, slightly tired"'
              defaultValue={instruct}
              onBlur={(e) => {
                if (e.target.value !== instruct) void player.setInstruct(e.target.value)
              }}
            />
          </SettingRow>
          <SettingRow label="Clone a voice">
            <DropZone
              Icon={FileAudio}
              label="Add a reference clip"
              hint="3–30 s clip of one speaker · wav, flac or ogg"
              accept="audio/*"
              onFile={(f) => void onClone(f)}
            />
          </SettingRow>
        </>
      )}
    </>
  )
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx -w frontend tsc -b` — expected: no errors.

```bash
git add frontend/src/components/settings/VoiceSection.tsx
git commit -m "feat(settings): voice section

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 8: Page shell (`SettingsPage.tsx`)

**Files:**
- Create: `frontend/src/components/settings/SettingsPage.tsx`

**Interfaces:**
- Consumes: `SECTIONS`, `Section` from `@/lib/view`; the four section components; `ReadingPreview`, `AppMiniature`.
- Produces:
  ```ts
  interface SettingsPageProps {
    section: Section
    onSectionChange: (s: Section) => void
    onClose: () => void
    prefs: ReadingPrefs
    update: (patch: Partial<ReadingPrefs>) => void
    theme: ThemePrefs
    dark: boolean
    updateTheme: (patch: Partial<ThemePrefs>) => void
    resetTheme: () => void
    wallpaper: WallpaperInfo | null
    uploadWallpaper: (file: Blob) => Promise<boolean>
    removeWallpaper: () => Promise<boolean>
  }
  export function SettingsPage(props: SettingsPageProps): JSX.Element
  ```

- [ ] **Step 1: Write `SettingsPage.tsx`**

```tsx
import { useEffect, useState } from "react"
import { Image as ImageIcon, MicVocal, Palette, Type, type LucideIcon } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"
import type { FontKey, ReadingPrefs } from "@/lib/reading"
import type { ThemePrefs } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { SECTIONS, type Section } from "@/lib/view"
import type { WallpaperInfo } from "@/lib/wallpaper"
import { AppMiniature } from "./AppMiniature"
import { AppearanceSection } from "./AppearanceSection"
import { ReadingPreview } from "./ReadingPreview"
import { ReadingSection } from "./ReadingSection"
import { VoiceSection } from "./VoiceSection"
import { WallpaperSection } from "./WallpaperSection"

export interface SettingsPageProps {
  section: Section
  onSectionChange: (s: Section) => void
  onClose: () => void
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  theme: ThemePrefs
  dark: boolean
  updateTheme: (patch: Partial<ThemePrefs>) => void
  resetTheme: () => void
  wallpaper: WallpaperInfo | null
  uploadWallpaper: (file: Blob) => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

const SECTION_META: Record<Section, { label: string; Icon: LucideIcon }> = {
  appearance: { label: "Appearance", Icon: Palette },
  reading: { label: "Reading", Icon: Type },
  wallpaper: { label: "Wallpaper", Icon: ImageIcon },
  voice: { label: "Voice", Icon: MicVocal },
}

const TILE_SPRING = { type: "spring", stiffness: 180, damping: 24 } as const

/** Settings as a window tile in place of the reader: rail · controls ·
 *  sticky preview. Everything applies live; there is nothing to save. */
export function SettingsPage(props: SettingsPageProps) {
  const { section, onSectionChange, onClose, prefs, update, theme, dark, updateTheme, resetTheme, wallpaper, uploadWallpaper, removeWallpaper } = props
  const [hoverFont, setHoverFont] = useState<FontKey | null>(null)

  // Escape closes the page — unless Radix already used it to dismiss a
  // popover (it calls preventDefault in a capture listener), or the user is
  // typing in a field (the style instruction commits on blur, not on Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      if ((e.target as HTMLElement | null)?.closest("input, textarea")) return
      onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const switchTo = (s: Section) => {
    setHoverFont(null)
    onSectionChange(s)
    if (window.scrollY > 0) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" })
    }
  }

  const preview =
    section === "reading" ? (
      <ReadingPreview prefs={prefs} hoverFont={hoverFont} />
    ) : section === "voice" ? null : (
      <AppMiniature prefs={prefs} theme={theme} dark={dark} wallpaper={wallpaper} caption={section} />
    )

  const controls =
    section === "appearance" ? (
      <AppearanceSection prefs={prefs} update={update} theme={theme} dark={dark} updateTheme={updateTheme} resetTheme={resetTheme} />
    ) : section === "reading" ? (
      <ReadingSection prefs={prefs} update={update} onHoverFont={setHoverFont} />
    ) : section === "wallpaper" ? (
      <WallpaperSection prefs={prefs} update={update} wallpaper={wallpaper} uploadWallpaper={uploadWallpaper} removeWallpaper={removeWallpaper} />
    ) : (
      <VoiceSection />
    )

  return (
    <main className="w-full flex-1 px-2 pt-2 pb-28 sm:px-3 sm:pt-3">
      <m.div
        initial={{ opacity: 0, scale: 0.985, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={TILE_SPRING}
        className="mx-auto max-w-[1180px] rounded-lg border bg-card/85 shadow-sm backdrop-blur-sm"
      >
        <header className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div>
            <h1 className="text-base font-semibold">Settings</h1>
            <p className="text-xs text-muted-foreground">Changes apply as you make them.</p>
          </div>
          <div className="flex items-center gap-2.5">
            <kbd className="font-mono text-[11px] text-muted-foreground max-sm:hidden">esc</kbd>
            <Button variant="outline" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </header>

        <div className="grid gap-x-8 gap-y-6 px-5 py-5 sm:px-6 md:grid-cols-[176px_minmax(0,1fr)] xl:grid-cols-[176px_minmax(0,1fr)_minmax(300px,380px)]">
          <nav aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
            {SECTIONS.map((s) => {
              const { label, Icon } = SECTION_META[s]
              const active = s === section
              return (
                <button
                  key={s}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => switchTo(s)}
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon className={cn("size-4", active && "text-(--accent-base)")} aria-hidden />
                  {label}
                </button>
              )
            })}
          </nav>

          <div className="min-w-0 max-w-[560px]">
            {/* Below xl the preview rides on top of the controls; the wrapper
                carries the tile background so controls scroll under it cleanly. */}
            {preview && (
              <div className="sticky top-17 z-10 -mx-5 mb-6 bg-card/85 px-5 pb-4 backdrop-blur-sm sm:-mx-6 sm:px-6 xl:hidden">
                {preview}
              </div>
            )}
            <m.div
              key={section}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="space-y-6"
            >
              {controls}
            </m.div>
          </div>

          {preview && (
            <aside className="max-xl:hidden">
              <div className="sticky top-17">{preview}</div>
            </aside>
          )}
        </div>
      </m.div>
    </main>
  )
}
```

The preview renders twice (one copy per breakpoint) so `position: sticky` has a tall enough containing block in both layouts; `AppMiniature` guards a zero-width hidden copy with `ratio > 0`.

- [ ] **Step 2: Type-check and commit**

Run: `npx -w frontend tsc -b` — expected: no errors.

```bash
git add frontend/src/components/settings/SettingsPage.tsx
git commit -m "feat(settings): page shell with rail, section switch and sticky preview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

---

### Task 9: Wire the page in, delete the dialog

**Files:**
- Modify: `frontend/src/App.tsx` (whole file below)
- Modify: `frontend/src/components/TopBar.tsx` (whole file below)
- Delete: `frontend/src/components/SettingsDialog.tsx`
- Modify: `README.md` (the "Aa menu" bullet)

**Interfaces:**
- Consumes: `useView` (Task 1), `SettingsPage` (Task 8), `wallpaperFitStyle` (Task 3).

- [ ] **Step 1: Rewrite `App.tsx`**

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { LazyMotion, MotionConfig, domAnimation } from "motion/react"
import { Toaster } from "sonner"
import { PasteDialog } from "@/components/PasteDialog"
import { PlayerBar } from "@/components/PlayerBar"
import { Reader } from "@/components/Reader"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { TopBar } from "@/components/TopBar"
import { player } from "@/lib/player"
import { useReadingPrefs } from "@/lib/reading"
import { useTheme } from "@/lib/theme"
import { useView } from "@/lib/view"
import { useWallpaper, wallpaperFitStyle, wallpaperUrl } from "@/lib/wallpaper"

export default function App() {
  const [pasteOpen, setPasteOpen] = useState(false)
  const { prefs, update } = useReadingPrefs()
  const { theme, dark, update: updateTheme, reset: resetTheme } = useTheme()
  const { wallpaper, upload: uploadWallpaper, remove: removeWallpaper } = useWallpaper()
  const { state: view, openSettings, setSection, closeSettings } = useView()
  const settingsOpen = view.view === "settings"

  useEffect(() => {
    player.start()
  }, [])

  // UI scale: rem-based chrome (bars, dialogs, controls) scales with the root
  // font-size; reading text is px-based and stays under its own Size pref.
  useEffect(() => {
    document.documentElement.style.fontSize = prefs.uiScale === 1 ? "" : `${prefs.uiScale * 100}%`
  }, [prefs.uiScale])

  // The reader unmounts while settings is open. Remember where it was and put
  // it back in a layout effect, which runs before the reader's useFollowChunk
  // passive effect — so the current sentence is already on the reading line
  // and the follow hook glides at most the distance playback advanced.
  const savedScroll = useRef(0)
  useLayoutEffect(() => {
    if (settingsOpen) {
      savedScroll.current = window.scrollY
      window.scrollTo(0, 0)
    } else {
      window.scrollTo(0, savedScroll.current)
    }
  }, [settingsOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        t.closest(
          "input, textarea, select, button, [role='dialog'], [role='listbox'], [role='menu'], [role='slider'], [contenteditable='true']",
        )
      ) {
        return
      }
      if (e.code === "Space") {
        e.preventDefault()
        player.togglePlay()
      } else if (e.code === "ArrowLeft") {
        player.jump(player.getSnapshot().idx - 1)
      } else if (e.code === "ArrowRight") {
        player.jump(player.getSnapshot().idx + 1)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const openPaste = () => setPasteOpen(true)

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <div className="flex min-h-dvh flex-col">
          {wallpaper && (
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 -z-10 transition-opacity duration-300"
              style={{
                backgroundImage: `url("${wallpaperUrl(wallpaper)}")`,
                backgroundPosition: prefs.wallpaperPos,
                opacity: prefs.wallpaperOpacity,
                ...wallpaperFitStyle(prefs.wallpaperFit),
              }}
            />
          )}
          <TopBar
            showClock={prefs.showClock}
            settingsOpen={settingsOpen}
            onSettingsClick={() => (settingsOpen ? closeSettings() : openSettings())}
            onPasteClick={openPaste}
          />
          {view.view === "settings" ? (
            <SettingsPage
              section={view.section}
              onSectionChange={setSection}
              onClose={closeSettings}
              prefs={prefs}
              update={update}
              theme={theme}
              dark={dark}
              updateTheme={updateTheme}
              resetTheme={resetTheme}
              wallpaper={wallpaper}
              uploadWallpaper={uploadWallpaper}
              removeWallpaper={removeWallpaper}
            />
          ) : (
            <Reader prefs={prefs} onPasteClick={openPaste} />
          )}
          <PlayerBar />
          <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} />
          <Toaster theme={dark ? "dark" : "light"} position="bottom-right" offset={{ bottom: Math.round(88 * prefs.uiScale) }} />
        </div>
      </LazyMotion>
    </MotionConfig>
  )
}
```

(`useReadingPrefs` still returns `reset`; it is simply no longer destructured. Leave the hook alone.)

- [ ] **Step 2: Rewrite `TopBar.tsx`**

```tsx
import { ClipboardPaste, Settings2 } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"
import { Clock } from "@/components/Clock"
import { usePlayer } from "@/lib/player"

interface Props {
  showClock: boolean
  settingsOpen: boolean
  onSettingsClick: () => void
  onPasteClick: () => void
}

export function TopBar({ showClock, settingsOpen, onSettingsClick, onPasteClick }: Props) {
  const { playing } = usePlayer()
  return (
    <header className="sticky top-0 z-20 px-2 pt-2 sm:px-3 sm:pt-3">
      <m.div
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="flex h-11 items-center gap-2.5 rounded-lg border bg-card/80 px-3 backdrop-blur"
      >
        {/* Workspace-tag dot: breathes while the voice is reading. */}
        <m.span
          aria-hidden
          className="size-2 rounded-[2px] bg-(--accent-base)"
          initial={false}
          animate={playing ? { opacity: [1, 0.4, 1], scale: [1, 0.8, 1] } : { opacity: 1, scale: 1 }}
          transition={playing ? { duration: 2, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3 }}
        />
        <span className="font-mono text-[13px] font-medium tracking-tight select-none">novel-tts</span>
        <div className="ml-auto flex items-center gap-1.5">
          {showClock && (
            <>
              <Clock />
              <div className="h-4 w-px bg-border" aria-hidden />
            </>
          )}
          <Button
            variant={settingsOpen ? "secondary" : "outline"}
            size="sm"
            onClick={onSettingsClick}
            aria-pressed={settingsOpen}
            title="Settings"
            aria-label="Settings"
          >
            <Settings2 className="size-3.5" aria-hidden />
            <span className="max-sm:hidden">Settings</span>
          </Button>
          <Button size="sm" onClick={onPasteClick} data-paste-trigger>
            <ClipboardPaste data-icon="inline-start" aria-hidden />
            Paste chapter
          </Button>
        </div>
      </m.div>
    </header>
  )
}
```

- [ ] **Step 3: Delete the dialog and update the README**

```bash
git rm -q frontend/src/components/SettingsDialog.tsx
```

In `README.md`, replace the bullet that begins `- Aa menu (top right): theme (light / dark / system)` with:

```markdown
- Settings (top right, also `#settings` in the URL): a page in place of the reader
  with a live preview — theme / palette / accent, reading font (18 faces, listed
  in their own face), size, line & paragraph spacing, text width, justify,
  auto-scroll, wallpaper fit / position / opacity, narrator and engine. Saved in
  the browser; Esc or the back button returns to the chapter.
```

- [ ] **Step 4: Build, lint, test**

Run: `npm run build -w frontend && npm run lint -w frontend && npm test -w frontend`
Expected: build succeeds; lint reports no errors (warnings about pre-existing files are fine); all tests pass. Then `git status` must show no leftover reference: `grep -rn SettingsDialog frontend/src desktop/src` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/TopBar.tsx README.md
git commit -m "feat(settings): replace the settings dialog with the settings page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

(`git rm` already staged the deletion. Do not stage `static/` or the pre-existing unrelated changes.)

---

### Task 10: Browser verification and polish

**Files:**
- Modify: any file from Tasks 4–9 that a screenshot shows needs a fix (spacing, wrapping, contrast). Keep fixes to what the screenshots justify.

Pre-req: the backend is reachable on `http://127.0.0.1:8765` (an SSH tunnel to the L4 box normally holds that port; `curl -s -m 5 http://127.0.0.1:8765/api/status | head -c 80` should print JSON). Start the dev server in the background: `npm run dev -w frontend -- --port 5173 --strictPort` (it proxies `/api` to 8765).

- [ ] **Step 1: Desktop screenshots, dark**

```bash
S=/private/tmp/claude-501/-Users-kuon-Documents-personal-tts-text/189f95d9-0493-4fbd-993f-56d6428bf2d8/scratchpad
agent-browser open http://localhost:5173/#settings/appearance --viewport 1440x900
agent-browser wait 1200
agent-browser screenshot $S/after-appearance.png
agent-browser find role button click "Reading";  agent-browser wait 400; agent-browser screenshot $S/after-reading.png
agent-browser hover "[data-font='lora']";          agent-browser wait 300; agent-browser screenshot $S/after-reading-hover.png
agent-browser find role button click "Wallpaper"; agent-browser wait 400; agent-browser screenshot $S/after-wallpaper.png
agent-browser find role button click "Voice";     agent-browser wait 400; agent-browser screenshot $S/after-voice.png
```

Read each PNG and check against the spec: three columns; preview sticky on the right; the hovered font shows in the preview with the "click to use" caption; the miniature shows the wallpaper, accent dot, highlighted line and progress fill; Voice has no preview and the controls column did not move.

- [ ] **Step 2: Light theme and the other palettes**

```bash
agent-browser find role button click "Appearance"; agent-browser find role radio click "Light"; agent-browser wait 500
agent-browser screenshot $S/after-light.png
agent-browser find role button click "Nord"; agent-browser wait 500; agent-browser screenshot $S/after-nord.png
agent-browser find role radio click "Dark"; agent-browser find role button click "Zinc"
```

Check: palette cards and swatches stay legible in light mode; the miniature recolours.

- [ ] **Step 3: Tablet and phone**

```bash
agent-browser open http://localhost:5173/#settings/reading --viewport 1024x768; agent-browser wait 1200; agent-browser screenshot $S/after-tablet.png
agent-browser scroll down 600; agent-browser wait 300; agent-browser screenshot $S/after-tablet-scrolled.png
agent-browser open http://localhost:5173/#settings/reading --viewport 390x844; agent-browser wait 1200; agent-browser screenshot $S/after-phone.png
agent-browser scroll down 600; agent-browser wait 300; agent-browser screenshot $S/after-phone-scrolled.png
```

Check: at 1024 the rail is a column and the preview sits above the controls and stays put while scrolling; at 390 the rail is a horizontal tab row, the preview is the compact strip with the fade, the page never scrolls horizontally.

- [ ] **Step 4: Keyboard, history and scroll restore**

```bash
agent-browser open http://localhost:5173/ --viewport 1440x900; agent-browser wait 1500
agent-browser scroll down 1200; agent-browser eval "window.scrollY"          # note the value
agent-browser find role button click "Settings"; agent-browser wait 500
agent-browser get url                                                        # ends with #settings/appearance
agent-browser eval "window.scrollY"                                          # 0
agent-browser press Escape; agent-browser wait 500
agent-browser get url                                                        # no hash
agent-browser eval "window.scrollY"                                          # the noted value (±2)
agent-browser find role button click "Settings"; agent-browser back; agent-browser wait 500; agent-browser get url   # no hash again
agent-browser open http://localhost:5173/#settings/reading; agent-browser wait 1000
agent-browser focus "[data-font='georgia']"; agent-browser press ArrowDown; agent-browser eval "JSON.parse(localStorage.getItem('novel-tts:reading')).font"   # "literata"
agent-browser press ArrowUp; agent-browser eval "JSON.parse(localStorage.getItem('novel-tts:reading')).font"                                                 # "georgia"
agent-browser find role combobox click "Narrator voice"; agent-browser press Escape; agent-browser get url   # still #settings/reading — Esc closed the popover only
```

If `useFollowChunk` visibly glides after Escape with auto-scroll on, that is expected only when playback advanced meanwhile; with playback paused the page must land exactly where it was.

- [ ] **Step 5: Fix what the screenshots show, then re-run the gates**

Run: `npm run build -w frontend && npm run lint -w frontend && npm test -w frontend`
Expected: all green.

- [ ] **Step 6: Commit the polish (if any) and the rebuilt `static/`**

`npm run build` regenerates the served bundle under `static/`, which is tracked and normally committed with UI changes (see `git log -- static | head`). Stage it together with any polish edits:

```bash
git add static frontend/src/components/settings
git commit -m "feat(settings): ship the settings page build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YNeYW2Yh9Jnzm2idsk6vrk"
```

Then close the browser session: `agent-browser close`.
