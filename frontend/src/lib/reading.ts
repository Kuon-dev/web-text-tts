import { useCallback, useState } from "react"

export type FontKey = "georgia" | "literata" | "inter" | "system"

export interface ReadingPrefs {
  font: FontKey
  size: number
  lineHeight: number
  width: number
  paraSpacing: number
  justify: boolean
  autoScroll: boolean
  wallpaperOpacity: number
}

export const FONT_STACKS: Record<FontKey, string> = {
  georgia: 'Georgia, "Times New Roman", serif',
  literata: '"Literata Variable", Georgia, serif',
  inter: '"Inter Variable", system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
}

export const FONT_LABELS: Record<FontKey, string> = {
  georgia: "Georgia",
  literata: "Literata",
  inter: "Inter",
  system: "System",
}

export const DEFAULT_PREFS: ReadingPrefs = {
  font: "georgia",
  size: 18,
  lineHeight: 1.75,
  width: 44,
  paraSpacing: 1.1,
  justify: false,
  autoScroll: true,
  wallpaperOpacity: 0.3,
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
    p.wallpaperOpacity = clamp(Number(p.wallpaperOpacity) || DEFAULT_PREFS.wallpaperOpacity, 0.05, 1)
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
