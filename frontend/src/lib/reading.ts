import { useCallback, useState } from "react"

export type FontKey =
  | "georgia"
  | "literata"
  | "lora"
  | "merriweather"
  | "ebgaramond"
  | "crimson"
  | "bitter"
  | "inter"
  | "nunito"
  | "atkinson"
  | "system"
  | "jetbrains"
  | "courier"
  | "caveat"
  | "dancing"
  | "patrick"
  | "comic"
  | "averia"

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
  wallpaperOpacity: number
  wallpaperFit: WallpaperFit
  /** CSS background-position, e.g. "center center" or "left top" */
  wallpaperPos: string
}

export const FONT_STACKS: Record<FontKey, string> = {
  georgia: 'Georgia, "Times New Roman", serif',
  literata: '"Literata Variable", Georgia, serif',
  lora: '"Lora Variable", Georgia, serif',
  merriweather: '"Merriweather Variable", Georgia, serif',
  ebgaramond: '"EB Garamond Variable", Garamond, Georgia, serif',
  crimson: '"Crimson Pro Variable", Georgia, serif',
  bitter: '"Bitter Variable", "Roboto Slab", Georgia, serif',
  inter: '"Inter Variable", system-ui, sans-serif',
  nunito: '"Nunito Variable", system-ui, sans-serif',
  atkinson: '"Atkinson Hyperlegible", system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  jetbrains: '"JetBrains Mono Variable", Consolas, monospace',
  courier: '"Courier Prime", "Courier New", monospace',
  caveat: '"Caveat Variable", cursive',
  dancing: '"Dancing Script Variable", cursive',
  patrick: '"Patrick Hand", cursive',
  comic: '"Comic Neue", "Comic Sans MS", cursive',
  averia: '"Averia Serif Libre", Georgia, serif',
}

export const FONT_LABELS: Record<FontKey, string> = {
  georgia: "Georgia",
  literata: "Literata",
  lora: "Lora",
  merriweather: "Merriweather",
  ebgaramond: "EB Garamond",
  crimson: "Crimson Pro",
  bitter: "Bitter",
  inter: "Inter",
  nunito: "Nunito",
  atkinson: "Atkinson Hyperlegible",
  system: "System",
  jetbrains: "JetBrains Mono",
  courier: "Courier Prime",
  caveat: "Caveat",
  dancing: "Dancing Script",
  patrick: "Patrick Hand",
  comic: "Comic Neue",
  averia: "Averia Serif",
}

/** Short style hints shown next to each font in the picker. */
export const FONT_HINTS: Record<FontKey, string> = {
  georgia: "classic",
  literata: "e-book",
  lora: "calligraphic",
  merriweather: "sturdy",
  ebgaramond: "old print",
  crimson: "elegant",
  bitter: "slab",
  inter: "modern",
  nunito: "rounded",
  atkinson: "high legibility",
  system: "device default",
  jetbrains: "coding",
  courier: "typewriter",
  caveat: "handwritten",
  dancing: "flowing cursive",
  patrick: "neat handprint",
  comic: "comic",
  averia: "storybook",
}

export const FONT_GROUPS: { label: string; fonts: FontKey[] }[] = [
  { label: "Serif", fonts: ["georgia", "literata", "lora", "merriweather", "ebgaramond", "crimson", "bitter"] },
  { label: "Sans serif", fonts: ["inter", "nunito", "atkinson", "system"] },
  { label: "Monospace", fonts: ["jetbrains", "courier"] },
  { label: "Handwriting", fonts: ["caveat", "dancing", "patrick"] },
  { label: "Stylized", fonts: ["comic", "averia"] },
]

export const DEFAULT_PREFS: ReadingPrefs = {
  font: "georgia",
  size: 18,
  lineHeight: 1.75,
  width: 44,
  paraSpacing: 1.1,
  justify: false,
  autoScroll: true,
  showClock: true,
  wallpaperOpacity: 0.3,
  wallpaperFit: "cover",
  wallpaperPos: "center center",
}

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

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setPrefs(DEFAULT_PREFS)
  }, [])

  return { prefs, update, reset }
}
