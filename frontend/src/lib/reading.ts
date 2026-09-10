import { useCallback, useState } from "react"

export type FontKey =
  | "literata"
  | "georgia"
  | "sourceserif"
  | "newsreader"
  | "charis"
  | "librebaskerville"
  | "merriweather"
  | "lora"
  | "ebgaramond"
  | "bitter"
  | "inter"
  | "sourcesans"
  | "notosans"
  | "atkinson"
  | "system"

export type WallpaperFit = "cover" | "contain" | "stretch" | "tile" | "center"

export const WALLPAPER_FIT_LABELS: Record<WallpaperFit, string> = {
  cover: "Fill screen",
  contain: "Fit inside",
  stretch: "Stretch",
  tile: "Tile",
  center: "Actual size",
}

export const WALLPAPER_POS_X = ["left", "center", "right"] as const
export const WALLPAPER_POS_Y = ["top", "center", "bottom"] as const

export interface ReadingPrefs {
  font: FontKey
  size: number
  lineHeight: number
  width: number
  paraSpacing: number
  justify: boolean
  autoScroll: boolean
  showClock: boolean
  /** Chrome scale factor (bars, dialogs, controls) — reading text is unaffected. */
  uiScale: number
  wallpaperOpacity: number
  wallpaperFit: WallpaperFit
  /** CSS background-position, e.g. "center center" or "left top" */
  wallpaperPos: string
}

/** Every face here was picked for hours of continuous reading: large
 *  x-height, low stroke contrast, open apertures, true italics. Literata,
 *  Source Serif 4 and Newsreader also carry an optical-size axis, which the
 *  browser drives from the font size on its own (font-optical-sizing: auto).
 *  No script, comic, or monospace faces — no e-reader ships them, and the
 *  reading-speed literature gives them nothing. */
export const FONT_STACKS: Record<FontKey, string> = {
  literata: '"Literata Variable", Georgia, serif',
  georgia: 'Georgia, "Times New Roman", serif',
  sourceserif: '"Source Serif 4 Variable", Georgia, serif',
  newsreader: '"Newsreader Variable", Georgia, serif',
  charis: '"Charis SIL", Charter, Georgia, serif',
  librebaskerville: '"Libre Baskerville Variable", Baskerville, Georgia, serif',
  merriweather: '"Merriweather Variable", Georgia, serif',
  lora: '"Lora Variable", Georgia, serif',
  ebgaramond: '"EB Garamond Variable", Garamond, Georgia, serif',
  bitter: '"Bitter Variable", "Roboto Slab", Georgia, serif',
  inter: '"Inter Variable", system-ui, sans-serif',
  sourcesans: '"Source Sans 3 Variable", system-ui, sans-serif',
  notosans: '"Noto Sans Variable", system-ui, sans-serif',
  atkinson: '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible", system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
}

export const FONT_LABELS: Record<FontKey, string> = {
  literata: "Literata",
  georgia: "Georgia",
  sourceserif: "Source Serif 4",
  newsreader: "Newsreader",
  charis: "Charis SIL",
  librebaskerville: "Libre Baskerville",
  merriweather: "Merriweather",
  lora: "Lora",
  ebgaramond: "EB Garamond",
  bitter: "Bitter",
  inter: "Inter",
  sourcesans: "Source Sans 3",
  notosans: "Noto Sans",
  atkinson: "Atkinson Hyperlegible Next",
  system: "System",
}

/** Short style hints shown next to each font in the picker. */
export const FONT_HINTS: Record<FontKey, string> = {
  literata: "e-book",
  georgia: "classic",
  sourceserif: "modern book",
  newsreader: "editorial",
  charis: "low contrast",
  librebaskerville: "bright, wide",
  merriweather: "sturdy",
  lora: "calligraphic",
  ebgaramond: "old print",
  bitter: "slab",
  inter: "modern",
  sourcesans: "humanist",
  notosans: "neutral",
  atkinson: "high legibility",
  system: "device default",
}

export const FONT_GROUPS: { label: string; fonts: FontKey[] }[] = [
  {
    label: "Serif",
    fonts: ["literata", "georgia", "sourceserif", "newsreader", "charis", "librebaskerville", "merriweather", "lora", "ebgaramond", "bitter"],
  },
  { label: "Sans serif", fonts: ["inter", "sourcesans", "notosans", "atkinson", "system"] },
]

export const DEFAULT_PREFS: ReadingPrefs = {
  font: "literata",
  size: 18,
  lineHeight: 1.75,
  width: 44,
  paraSpacing: 1.1,
  justify: false,
  autoScroll: true,
  showClock: true,
  uiScale: 1,
  wallpaperOpacity: 0.3,
  wallpaperFit: "cover",
  wallpaperPos: "center center",
}

/** Reader column cap in px for a Text width pref: 16px per unit plus a
 *  6-unit allowance for the tile's horizontal padding. The settings preview
 *  caption quotes the same figure. */
export const readerMaxWidth = (width: number): number => (width + 6) * 16

const STORAGE_KEY = "novel-tts:reading"

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function loadPrefs(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const p = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as ReadingPrefs
    if (!(p.font in FONT_STACKS)) p.font = DEFAULT_PREFS.font
    p.size = clamp(Number(p.size) || DEFAULT_PREFS.size, 14, 26)
    p.lineHeight = clamp(Number(p.lineHeight) || DEFAULT_PREFS.lineHeight, 1.3, 2.4)
    p.width = clamp(Number(p.width) || DEFAULT_PREFS.width, 34, 60)
    p.paraSpacing = clamp(Number(p.paraSpacing) || DEFAULT_PREFS.paraSpacing, 0.4, 2.4)
    p.justify = typeof p.justify === "boolean" ? p.justify : DEFAULT_PREFS.justify
    p.autoScroll = typeof p.autoScroll === "boolean" ? p.autoScroll : DEFAULT_PREFS.autoScroll
    p.showClock = typeof p.showClock === "boolean" ? p.showClock : DEFAULT_PREFS.showClock
    p.uiScale = clamp(Number(p.uiScale) || DEFAULT_PREFS.uiScale, 0.85, 1.5)
    p.wallpaperOpacity = clamp(Number(p.wallpaperOpacity) || DEFAULT_PREFS.wallpaperOpacity, 0.05, 1)
    if (!(p.wallpaperFit in WALLPAPER_FIT_LABELS)) p.wallpaperFit = DEFAULT_PREFS.wallpaperFit
    if (!/^(left|center|right) (top|center|bottom)$/.test(p.wallpaperPos)) p.wallpaperPos = DEFAULT_PREFS.wallpaperPos
    return p
  } catch {
    return DEFAULT_PREFS
  }
}

export function useReadingPrefs() {
  const [prefs, setPrefs] = useState<ReadingPrefs>(loadPrefs)

  const update = useCallback((patch: Partial<ReadingPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* private mode etc. — prefs just won't persist */
      }
      return next
    })
  }, [])

  return { prefs, update }
}
