import { useCallback, useEffect, useState } from "react"

export type ThemeMode = "light" | "dark" | "system"
export type AccentKey = "indigo" | "emerald" | "rose" | "amber" | "sky"

export interface ThemePrefs {
  mode: ThemeMode
  accent: AccentKey
}

export const ACCENT_LABELS: Record<AccentKey, string> = {
  indigo: "Indigo",
  emerald: "Emerald",
  rose: "Rose",
  amber: "Amber",
  sky: "Sky",
}

/** Swatch colors for the settings menu — keep in sync with the
 *  [data-accent] rules in index.css and the inline script in index.html. */
export const ACCENT_SWATCHES: Record<AccentKey, string> = {
  indigo: "oklch(0.585 0.233 277.117)",
  emerald: "oklch(0.696 0.17 162.48)",
  rose: "oklch(0.645 0.246 16.439)",
  amber: "oklch(0.769 0.188 70.08)",
  sky: "oklch(0.685 0.169 237.323)",
}

export const DEFAULT_THEME: ThemePrefs = { mode: "dark", accent: "indigo" }

const STORAGE_KEY = "novel-tts:theme"

function loadTheme(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_THEME
    const t = { ...DEFAULT_THEME, ...JSON.parse(raw) } as ThemePrefs
    if (!["light", "dark", "system"].includes(t.mode)) t.mode = DEFAULT_THEME.mode
    if (!(t.accent in ACCENT_LABELS)) t.accent = DEFAULT_THEME.accent
    return t
  } catch {
    return DEFAULT_THEME
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemePrefs>(loadTheme)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches)

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  const dark = theme.mode === "system" ? systemDark : theme.mode === "dark"

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle("dark", dark)
    root.dataset.accent = theme.accent
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#131316" : "#fafafa")
  }, [dark, theme.accent])

  const update = useCallback((patch: Partial<ThemePrefs>) => {
    setTheme((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* private mode etc. — theme just won't persist */
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
    setTheme(DEFAULT_THEME)
  }, [])

  return { theme, dark, update, reset }
}
