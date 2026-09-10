import { useEffect, useRef } from "react"
import { ClipboardPaste, Settings2 } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"
import { usePlayer } from "@/lib/player"
import { cn } from "@/lib/utils"
import { Bracket, DockDivider } from "./Bracket"

interface Props {
  settingsOpen: boolean
  onSettingsClick: () => void
  onPasteClick: () => void
}

// Resting height of each bar (fraction of the glyph box) and the loop it runs
// while the voice reads. The periods differ so the three never fall into step.
const BARS = [
  { rest: 0.35, loop: [0.35, 0.9, 0.5, 0.75, 0.35], dur: 1.15 },
  { rest: 0.6, loop: [0.6, 0.3, 1, 0.45, 0.6], dur: 0.95 },
  { rest: 0.45, loop: [0.45, 0.8, 0.3, 0.7, 0.45], dur: 1.3 },
]

/** The bar's identity item: a three-bar level meter in the user's accent that
 *  dances while the voice reads and settles low while it doesn't. It is the
 *  old workspace-tag dot, now saying what the app is doing. */
function Meter({ playing }: { playing: boolean }) {
  return (
    <span aria-hidden className="flex size-3.5 items-end justify-center gap-[2px]">
      {BARS.map((b, i) => (
        <m.span
          key={i}
          className="h-full w-[2px] origin-bottom rounded-[1px] bg-(--accent-base)"
          initial={false}
          animate={{ scaleY: playing ? b.loop : b.rest }}
          transition={
            playing
              ? { duration: b.dur, repeat: Infinity, ease: "easeInOut" }
              : { type: "spring", stiffness: 300, damping: 26 }
          }
        />
      ))}
    </span>
  )
}

/** Left bracket: who this is, plus the two actions that used to live in the
 *  top bar. Settings reads as the active space while its page is open. */
export function SystemBracket({ settingsOpen, onSettingsClick, onPasteClick }: Props) {
  const { playing } = usePlayer()
  const settingsRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(settingsOpen)
  useEffect(() => {
    // Only on the open → closed edge (never on mount), and only when the page's
    // unmount dropped focus on the body — a click elsewhere keeps its target.
    if (wasOpen.current && !settingsOpen && document.activeElement === document.body) {
      settingsRef.current?.focus()
    }
    wasOpen.current = settingsOpen
  }, [settingsOpen])

  return (
    <Bracket label="App" delay={0.1} className="justify-self-start">
      <span className="flex h-7 items-center gap-2 px-1.5 whitespace-nowrap select-none max-sm:hidden" title={playing ? "Reading" : "Paused"}>
        <Meter playing={playing} />
        <span className="font-mono text-xs font-medium tracking-tight max-xl:hidden">novel-tts</span>
      </span>
      <DockDivider />
      <Button
        variant="outline"
        size="sm"
        onClick={onPasteClick}
        data-paste-trigger
        title="Paste chapter"
        aria-label="Paste chapter"
        className="max-sm:w-7 max-sm:px-0"
      >
        <ClipboardPaste aria-hidden />
        <span className="max-sm:hidden">
          Paste<span className="max-xl:hidden"> chapter</span>
        </span>
      </Button>
      <Button
        ref={settingsRef}
        variant="ghost"
        size="sm"
        onClick={onSettingsClick}
        aria-pressed={settingsOpen}
        title="Settings"
        aria-label="Settings"
        className={cn("max-lg:w-7 max-lg:px-0", settingsOpen && "bg-secondary text-foreground")}
      >
        <Settings2 className={cn("size-3.5 transition-colors", settingsOpen && "text-(--accent-base)")} aria-hidden />
        <span className="max-lg:hidden">Settings</span>
      </Button>
    </Bracket>
  )
}
