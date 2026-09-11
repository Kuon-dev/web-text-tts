import { useEffect, useRef, useState } from "react"
import { Image as ImageIcon, MicVocal, Palette, Type, type LucideIcon } from "lucide-react"
import { m } from "motion/react"
import { TILE_FRAME } from "@/components/tile"
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
 *  preview. The window is the same size for every section — it fills the
 *  frame the reader's tile fills (TILE_FRAME), the way System Settings keeps
 *  one window and scrolls only its content — so the header, the rail and
 *  the preview stay put and the controls pane scrolls on its own.
 *  Everything applies live; there is nothing to save. */
export function SettingsPage(props: SettingsPageProps) {
  const { section, onSectionChange, onClose, prefs, update, theme, dark, updateTheme, resetTheme, wallpaper, uploadWallpaper, removeWallpaper } = props
  const [hoverFont, setHoverFont] = useState<FontKey | null>(null)
  const pane = useRef<HTMLDivElement>(null)

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

  // Every section change, hash-driven ones included, clears the hovered font
  // and starts the pane at its top (smoothly, unless motion is reduced).
  useEffect(() => {
    setHoverFont(null)
    const el = pane.current
    if (el && el.scrollTop > 0) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" })
    }
  }, [section])

  const switchTo = (s: Section) => onSectionChange(s)

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
    <main className={TILE_FRAME}>
      <m.div
        initial={{ opacity: 0, scale: 0.985, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={TILE_SPRING}
        className="mx-auto flex h-full max-w-[1180px] flex-col overflow-hidden rounded-lg border bg-card/85 shadow-sm backdrop-blur-sm"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
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

        {/* Below md the rail is a row above the pane; from md up it is the
            left column. Only the pane (the middle cell) scrolls. */}
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-x-8 md:grid-cols-[176px_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[176px_minmax(0,1fr)_minmax(300px,380px)]">
          <nav
            aria-label="Settings sections"
            className="flex gap-1 overflow-x-auto px-5 pt-5 sm:px-6 md:flex-col md:overflow-visible md:pr-0 md:pb-5"
          >
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

          <div
            ref={pane}
            className="min-h-0 min-w-0 overflow-y-auto px-5 pb-5 [scrollbar-gutter:stable] [scrollbar-width:thin] sm:px-6 md:pl-0 md:pr-4"
          >
            {/* Below xl the preview rides on top of the controls, pinned to
                the top of the pane; the wrapper carries the tile background
                so controls scroll under it cleanly, and keeps the 560px cap
                the controls have. The pane has no top padding of its own
                (padding would hold a sticky child that far below the edge and
                let scrolled rows show in the gap), so the top spacing belongs
                to the wrapper, or to the controls when nothing is pinned. */}
            {preview && (
              <div className="sticky top-0 z-10 -mx-5 mb-6 bg-card/90 px-5 pt-5 pb-4 backdrop-blur-md sm:-mx-6 sm:px-6 md:-mr-4 md:ml-0 md:pl-0 md:pr-4 xl:hidden">
                <div className="max-w-[560px]">{preview}</div>
              </div>
            )}
            <m.div
              key={section}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className={cn("max-w-[560px] space-y-6", preview ? "xl:pt-5" : "pt-5")}
            >
              {controls}
            </m.div>
          </div>

          {preview && <aside className="py-5 pr-5 max-xl:hidden sm:pr-6">{preview}</aside>}
        </div>
      </m.div>
    </main>
  )
}
