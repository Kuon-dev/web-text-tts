import { useEffect, useState } from "react"
import { Toaster } from "sonner"
import { PasteDialog } from "@/components/PasteDialog"
import { PlayerBar } from "@/components/PlayerBar"
import { Reader } from "@/components/Reader"
import { TopBar } from "@/components/TopBar"
import { player } from "@/lib/player"
import { useReadingPrefs } from "@/lib/reading"

export default function App() {
  const [pasteOpen, setPasteOpen] = useState(false)
  const { prefs, update, reset } = useReadingPrefs()

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

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar prefs={prefs} update={update} reset={reset} onPasteClick={openPaste} />
      <Reader prefs={prefs} onPasteClick={openPaste} />
      <PlayerBar />
      <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} />
      <Toaster theme="dark" position="bottom-right" offset={{ bottom: 88 }} />
    </div>
  )
}
