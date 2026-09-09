import { ClipboardPaste, Settings2 } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"
import { Clock } from "@/components/Clock"
import { usePlayer } from "@/lib/player"

interface Props {
  showClock: boolean
  settingsOpen: boolean
  onSettingsClick: () => void
  onPasteClick: () => void
}

export function TopBar({ showClock, settingsOpen, onSettingsClick, onPasteClick }: Props) {
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
          {showClock && (
            <>
              <Clock />
              <div className="h-4 w-px bg-border" aria-hidden />
            </>
          )}
          <Button
            variant={settingsOpen ? "secondary" : "outline"}
            size="sm"
            onClick={onSettingsClick}
            aria-pressed={settingsOpen}
            title="Settings"
            aria-label="Settings"
          >
            <Settings2 className="size-3.5" aria-hidden />
            <span className="max-sm:hidden">Settings</span>
          </Button>
          <Button size="sm" onClick={onPasteClick} data-paste-trigger>
            <ClipboardPaste data-icon="inline-start" aria-hidden />
            Paste chapter
          </Button>
        </div>
      </m.div>
    </header>
  )
}
