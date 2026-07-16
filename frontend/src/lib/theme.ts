import { useCallback, useEffect, useState } from "react"
import { flushSync } from "react-dom"

export type ThemeMode = "light" | "dark" | "system"
export type AccentKey = "indigo" | "emerald" | "rose" | "amber" | "sky"
export type SchemeKey =
  | "zinc"
  | "catppuccin"
  | "dracula"
  | "everforest"
  | "gruvbox"
  | "nord"
  | "rosepine"
  | "solarized"
  | "tokyonight"

export interface ThemePrefs {
  mode: ThemeMode
  accent: AccentKey
  scheme: SchemeKey
}

/** The accent keys are stable storage ids; each names a hue slot that the
 *  active scheme fills with its own palette color (see --ac-* in index.css). */
export const ACCENT_LABELS: Record<AccentKey, string> = {
  indigo: "Violet",
  emerald: "Green",
  rose: "Rose",
  amber: "Amber",
  sky: "Blue",
}

/** Swatch fills for the settings menu — var() so the swatches themselves
 *  follow the active scheme and light/dark mode. */
export const ACCENT_SWATCHES: Record<AccentKey, string> = {
  indigo: "var(--ac-violet)",
  emerald: "var(--ac-green)",
  rose: "var(--ac-rose)",
  amber: "var(--ac-amber)",
  sky: "var(--ac-blue)",
}

export const SCHEME_LABELS: Record<SchemeKey, string> = {
  zinc: "Zinc",
  catppuccin: "Catppuccin",
  dracula: "Dracula",
  everforest: "Everforest",
  gruvbox: "Gruvbox",
  nord: "Nord",
  rosepine: "Rosé Pine",
  solarized: "Solarized",
  tokyonight: "Tokyo Night",
}

/** Five accent dots (rose → amber → green → blue → violet) per mode for the
 *  palette picker preview. Mirrors the --ac-* values in index.css. */
export const SCHEME_PREVIEWS: Record<SchemeKey, { light: string[]; dark: string[] }> = {
  zinc: {
    light: [
      "oklch(0.645 0.246 16.439)",
      "oklch(0.769 0.188 70.08)",
      "oklch(0.696 0.17 162.48)",
      "oklch(0.685 0.169 237.323)",
      "oklch(0.585 0.233 277.117)",
    ],
    dark: [
      "oklch(0.645 0.246 16.439)",
      "oklch(0.769 0.188 70.08)",
      "oklch(0.696 0.17 162.48)",
      "oklch(0.685 0.169 237.323)",
      "oklch(0.585 0.233 277.117)",
    ],
  },
  catppuccin: {
    light: ["#d20f39", "#fe640b", "#40a02b", "#1e66f5", "#8839ef"],
    dark: ["#f38ba8", "#fab387", "#a6e3a1", "#89b4fa", "#cba6f7"],
  },
  dracula: {
    light: ["#a3144d", "#a34d14", "#14710a", "#036a96", "#644ac9"],
    dark: ["#ff79c6", "#ffb86c", "#50fa7b", "#8be9fd", "#bd93f9"],
  },
  everforest: {
    light: ["#f85552", "#dfa000", "#8da101", "#3a94c5", "#df69ba"],
    dark: ["#e67e80", "#dbbc7f", "#a7c080", "#7fbbb3", "#d699b6"],
  },
  gruvbox: {
    light: ["#9d0006", "#b57614", "#79740e", "#076678", "#8f3f71"],
    dark: ["#fb4934", "#fabd2f", "#b8bb26", "#83a598", "#d3869b"],
  },
  nord: {
    light: ["#bf616a", "#d08770", "#a3be8c", "#5e81ac", "#b48ead"],
    dark: ["#bf616a", "#ebcb8b", "#a3be8c", "#88c0d0", "#b48ead"],
  },
  rosepine: {
    light: ["#b4637a", "#ea9d34", "#286983", "#56949f", "#907aa9"],
    dark: ["#eb6f92", "#f6c177", "#31748f", "#9ccfd8", "#c4a7e7"],
  },
  solarized: {
    light: ["#d33682", "#b58900", "#859900", "#268bd2", "#6c71c4"],
    dark: ["#d33682", "#b58900", "#859900", "#268bd2", "#6c71c4"],
  },
  tokyonight: {
    light: ["#f52a65", "#b15c00", "#587539", "#2e7de9", "#7847bd"],
    dark: ["#f7768e", "#e0af68", "#9ece6a", "#7aa2f7", "#bb9af7"],
  },
}

export const DEFAULT_THEME: ThemePrefs = { mode: "dark", accent: "indigo", scheme: "zinc" }

const STORAGE_KEY = "novel-tts:theme"

function loadTheme(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_THEME
    const t = { ...DEFAULT_THEME, ...JSON.parse(raw) } as ThemePrefs
    if (!["light", "dark", "system"].includes(t.mode)) t.mode = DEFAULT_THEME.mode
    if (!(t.accent in ACCENT_LABELS)) t.accent = DEFAULT_THEME.accent
    if (!(t.scheme in SCHEME_LABELS)) t.scheme = DEFAULT_THEME.scheme
    return t
  } catch {
    return DEFAULT_THEME
  }
}

function applyTheme(dark: boolean, accent: AccentKey, scheme: SchemeKey) {
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.dataset.accent = accent
  root.dataset.scheme = scheme
  // Browser chrome follows whatever background the scheme resolved to.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", getComputedStyle(document.body).backgroundColor)
}

function isDark(prefs: ThemePrefs, systemDark: boolean): boolean {
  return prefs.mode === "system" ? systemDark : prefs.mode === "dark"
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

  const dark = isDark(theme, systemDark)

  useEffect(() => {
    applyTheme(dark, theme.accent, theme.scheme)
  }, [dark, theme.accent, theme.scheme])

  // Commit a theme change, cross-fading the page via the View Transitions
  // API where supported; instant switch elsewhere or under reduced motion.
  const commit = useCallback(
    (next: ThemePrefs) => {
      if (
        typeof document.startViewTransition !== "function" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setTheme(next)
        return
      }
      document.startViewTransition(() => {
        flushSync(() => setTheme(next))
        // The passive effect above may run after the new-state snapshot is
        // captured — force the DOM into the new theme now (idempotent).
        applyTheme(isDark(next, systemDark), next.accent, next.scheme)
      })
    },
    [systemDark],
  )

  const update = useCallback(
    (patch: Partial<ThemePrefs>) => {
      const next = { ...theme, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* private mode etc. — theme just won't persist */
      }
      commit(next)
    },
    [theme, commit],
  )

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    commit(DEFAULT_THEME)
  }, [commit])

  return { theme, dark, update, reset }
}
