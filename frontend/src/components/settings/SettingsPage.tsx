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

  // Clear the hovered font on every section change, hash-driven ones included.
  useEffect(() => setHoverFont(null), [section])

  const switchTo = (s: Section) => {
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
              <div className="sticky top-13 z-10 -mx-5 -mt-4 mb-6 bg-card/85 px-5 pt-4 pb-4 backdrop-blur-sm sm:-mx-6 sm:px-6 xl:hidden">
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
