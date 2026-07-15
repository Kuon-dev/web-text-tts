import { useEffect, useState } from "react"
import { LazyMotion, MotionConfig, domAnimation } from "motion/react"
import { Toaster } from "sonner"
import { PasteDialog } from "@/components/PasteDialog"
import { PlayerBar } from "@/components/PlayerBar"
import { Reader } from "@/components/Reader"
import { TopBar } from "@/components/TopBar"
import { player } from "@/lib/player"
import { useReadingPrefs } from "@/lib/reading"
import { useTheme } from "@/lib/theme"
import { useWallpaper, wallpaperUrl } from "@/lib/wallpaper"

export default function App() {
  const [pasteOpen, setPasteOpen] = useState(false)
  const { prefs, update, reset } = useReadingPrefs()
  const { theme, dark, update: updateTheme, reset: resetTheme } = useTheme()
  const { wallpaper, upload: uploadWallpaper, remove: removeWallpaper } = useWallpaper()

  useEffect(() => {
    player.start()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        t.closest(
          "input, textarea, select, button, [role='dialog'], [role='listbox'], [role='menu'], [role='slider'], [contenteditable='true']",
        )
      ) {
        return
      }
      if (e.code === "Space") {
        e.preventDefault()
        player.togglePlay()
      } else if (e.code === "ArrowLeft") {
        player.jump(player.getSnapshot().idx - 1)
      } else if (e.code === "ArrowRight") {
        player.jump(player.getSnapshot().idx + 1)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const openPaste = () => setPasteOpen(true)
  const resetAll = () => {
    reset()
    resetTheme()
  }

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <div className="flex min-h-dvh flex-col">
          {wallpaper && (
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center transition-opacity duration-300"
              style={{ backgroundImage: `url("${wallpaperUrl(wallpaper)}")`, opacity: prefs.wallpaperOpacity }}
            />
          )}
          <TopBar
            prefs={prefs}
            update={update}
            theme={theme}
            updateTheme={updateTheme}
            reset={resetAll}
            onPasteClick={openPaste}
            wallpaper={wallpaper}
            uploadWallpaper={uploadWallpaper}
            removeWallpaper={removeWallpaper}
          />
          <Reader prefs={prefs} onPasteClick={openPaste} />
          <PlayerBar />
          <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} />
          <Toaster theme={dark ? "dark" : "light"} position="bottom-right" offset={{ bottom: 88 }} />
        </div>
      </LazyMotion>
    </MotionConfig>
  )
}
