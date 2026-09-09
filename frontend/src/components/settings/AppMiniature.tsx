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
    <div className="max-w-[360px] space-y-2 xl:max-w-none">
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
          <div className="flex h-full flex-col justify-center space-y-[4%]">
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
