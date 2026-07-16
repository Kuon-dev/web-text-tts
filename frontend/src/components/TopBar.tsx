import { ClipboardPaste } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"
import { Clock } from "@/components/Clock"
import { SettingsDialog } from "@/components/SettingsDialog"
import { usePlayer } from "@/lib/player"
import type { ReadingPrefs } from "@/lib/reading"
import type { ThemePrefs } from "@/lib/theme"
import type { WallpaperInfo } from "@/lib/wallpaper"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  theme: ThemePrefs
  dark: boolean
  updateTheme: (patch: Partial<ThemePrefs>) => void
  reset: () => void
  onPasteClick: () => void
  wallpaper: WallpaperInfo | null
  uploadWallpaper: (file: Blob) => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

export function TopBar({ prefs, update, theme, dark, updateTheme, reset, onPasteClick, wallpaper, uploadWallpaper, removeWallpaper }: Props) {
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
          {prefs.showClock && (
            <>
              <Clock />
              <div className="h-4 w-px bg-border" aria-hidden />
            </>
          )}
          <SettingsDialog
            prefs={prefs}
            update={update}
            theme={theme}
            dark={dark}
            updateTheme={updateTheme}
            reset={reset}
            wallpaper={wallpaper}
            uploadWallpaper={uploadWallpaper}
            removeWallpaper={removeWallpaper}
          />
          <Button size="sm" onClick={onPasteClick}>
            <ClipboardPaste data-icon="inline-start" aria-hidden />
            Paste chapter
          </Button>
        </div>
      </m.div>
    </header>
  )
}
