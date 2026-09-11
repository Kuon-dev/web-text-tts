import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LazyMotion, MotionConfig, domAnimation } from "motion/react"
import { AdjustHUD } from "@/components/AdjustHUD"
import { CommandPalette, type PalettePage } from "@/components/CommandPalette"
import { Dock } from "@/components/dock/Dock"
import { EngineToasts } from "@/components/EngineToasts"
import { PasteDialog } from "@/components/PasteDialog"
import { Reader } from "@/components/Reader"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { ShortcutsDialog } from "@/components/ShortcutsDialog"
import { Toaster } from "@/components/ui/sonner"
import { matchAction, type KeymapCtx } from "@/lib/keymap"
import { player } from "@/lib/player"
import { useReadingPrefs } from "@/lib/reading"
import { useTheme } from "@/lib/theme"
import { useView } from "@/lib/view"
import { useWallpaper, wallpaperFitStyle, wallpaperUrl } from "@/lib/wallpaper"

/**
 * The one keydown listener, replacing the hand-rolled Space / ←/→ block this
 * file used to carry. Which shortcuts may fire is two orthogonal questions,
 * not the single condition it was: a modifier-less key must never fire while
 * the user is typing (`p` would land in the paste box instead of opening it),
 * and a reader-scope key must additionally stand down whenever a control has
 * focus or an overlay is up — that is what keeps Space activating a focused
 * dock button rather than toggling playback, exactly as before.
 *
 * The listener is installed once and reads its inputs through a ref: rebinding
 * it whenever a dialog opens would be churn for no gain, and the matcher needs
 * the *current* overlay state, not the state at subscribe time.
 */
function useKeymap(ctx: KeymapCtx, overlayOpen: boolean) {
  const latest = useRef({ ctx, overlayOpen })
  latest.current = { ctx, overlayOpen }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const action = matchAction(e, {
        textEntry: !!t?.closest("input, textarea, [contenteditable='true']"),
        controlFocused: !!t?.closest(
          "button, select, [role='slider'], [role='listbox'], [role='menu'], [role='dialog']",
        ),
        overlayOpen: latest.current.overlayOpen,
      })
      if (!action) return
      e.preventDefault()
      action.run(latest.current.ctx)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])
}

export default function App() {
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [palettePage, setPalettePage] = useState<PalettePage | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
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

  const openPaste = useCallback(() => setPasteOpen(true), [])

  // The settings page is deliberately absent from `overlayOpen`: it is a view,
  // not an overlay, so Space keeps pausing the voice while fonts are changed.
  const overlayOpen = pasteOpen || paletteOpen || helpOpen

  const keymapCtx = useMemo<KeymapCtx>(
    () => ({
      openPalette: () => {
        setPalettePage(null)
        setPaletteOpen(true)
      },
      openPalettePage: (page) => {
        setPalettePage(page)
        setPaletteOpen(true)
      },
      openHelp: () => setHelpOpen(true),
      openPaste,
      toggleSettings: () => (settingsOpen ? closeSettings() : openSettings()),
    }),
    [openPaste, settingsOpen, closeSettings, openSettings],
  )
  useKeymap(keymapCtx, overlayOpen)

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
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialPage={palettePage} ctx={keymapCtx} />
          <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
          <AdjustHUD />
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
