import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { LazyMotion, MotionConfig, domAnimation } from "motion/react"
import { Dock } from "@/components/dock/Dock"
import { EngineToasts } from "@/components/EngineToasts"
import { PasteDialog } from "@/components/PasteDialog"
import { Reader } from "@/components/Reader"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { Toaster } from "@/components/ui/sonner"
import { player } from "@/lib/player"
import { useReadingPrefs } from "@/lib/reading"
import { useTheme } from "@/lib/theme"
import { useView } from "@/lib/view"
import { useWallpaper, wallpaperFitStyle, wallpaperUrl } from "@/lib/wallpaper"

export default function App() {
  const [pasteOpen, setPasteOpen] = useState(false)
  const { prefs, update } = useReadingPrefs()
  const { theme, dark, update: updateTheme, reset: resetTheme } = useTheme()
  const { wallpaper, upload: uploadWallpaper, remove: removeWallpaper } = useWallpaper()
  const { state: view, openSettings, setSection, closeSettings } = useView()
  const settingsOpen = view.view === "settings"

  useEffect(() => {
    player.start()
  }, [])

  // UI scale: rem-based chrome (bars, dialogs, controls) scales with the root
  // font-size; reading text is px-based and stays under its own Size pref.
  useEffect(() => {
    document.documentElement.style.fontSize = prefs.uiScale === 1 ? "" : `${prefs.uiScale * 100}%`
  }, [prefs.uiScale])

  // The reader unmounts while settings is open. Its scroll offset is tracked
  // while it is mounted (by the time the view flips, the reader is gone and
  // window.scrollY has already been clamped to the settings page's height),
  // snapshotted when settings opens, and put back in a layout effect on close.
  // Layout effects run before the reader's useFollowChunk passive effect, so
  // the current sentence is already on the reading line and the follow hook
  // glides at most the distance playback advanced.
  const readerScroll = useRef(0)
  const savedScroll = useRef(0)
  useEffect(() => {
    if (settingsOpen) return
    const onScroll = () => {
      readerScroll.current = window.scrollY
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [settingsOpen])
  useLayoutEffect(() => {
    if (settingsOpen) {
      savedScroll.current = readerScroll.current
      window.scrollTo(0, 0)
    } else {
      window.scrollTo(0, savedScroll.current)
    }
  }, [settingsOpen])

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

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <div className="flex min-h-dvh flex-col">
          {wallpaper && (
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 -z-10 transition-opacity duration-300"
              style={{
                backgroundImage: `url("${wallpaperUrl(wallpaper)}")`,
                backgroundPosition: prefs.wallpaperPos,
                opacity: prefs.wallpaperOpacity,
                ...wallpaperFitStyle(prefs.wallpaperFit),
              }}
            />
          )}
          {view.view === "settings" ? (
            <SettingsPage
              section={view.section}
              onSectionChange={setSection}
              onClose={closeSettings}
              prefs={prefs}
              update={update}
              theme={theme}
              dark={dark}
              updateTheme={updateTheme}
              resetTheme={resetTheme}
              wallpaper={wallpaper}
              uploadWallpaper={uploadWallpaper}
              removeWallpaper={removeWallpaper}
            />
          ) : (
            <Reader prefs={prefs} onPasteClick={openPaste} />
          )}
          <Dock
            showClock={prefs.showClock}
            settingsOpen={settingsOpen}
            onSettingsClick={() => (settingsOpen ? closeSettings() : openSettings())}
            onPasteClick={openPaste}
          />
          <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} />
          <EngineToasts />
          {/* Toasts stack above the dock, whatever its height (see --dock-h). */}
          <Toaster
            theme={dark ? "dark" : "light"}
            position="bottom-right"
            offset={{ bottom: "calc(var(--dock-h) + 0.75rem)" }}
            mobileOffset={{ bottom: "calc(var(--dock-h) + 0.5rem)" }}
          />
        </div>
      </LazyMotion>
    </MotionConfig>
  )
}
