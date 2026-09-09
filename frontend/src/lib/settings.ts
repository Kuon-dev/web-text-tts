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
