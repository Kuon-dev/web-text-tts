import type { MouseEvent } from "react"
import { Loader2 } from "lucide-react"
import { m } from "motion/react"
import { useEngineLabel } from "@/components/EngineModePicker"
import { player, usePlayer } from "@/lib/player"
import { NarrationBracket, StatusBracket } from "./Modules"
import { NowPlaying } from "./NowPlaying"
import { SystemBracket } from "./SystemBracket"

interface Props {
  showClock: boolean
  settingsOpen: boolean
  onSettingsClick: () => void
  onPasteClick: () => void
}

/** Chapter progress as the bar's top edge; click anywhere on it to jump. */
function ProgressRail({ n, idx }: { n: number; idx: number }) {
  const pct = n ? ((idx + 1) / n) * 100 : 0
  const scrub = (e: MouseEvent<HTMLDivElement>) => {
    if (!n) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - r.left) / r.width
    player.jump(Math.round(ratio * (n - 1)))
  }
  return (
    <div
      className="group/progress relative h-1 w-full cursor-pointer bg-secondary transition-[height] hover:h-1.5"
      onClick={scrub}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={n}
      aria-valuenow={n ? idx + 1 : 0}
      aria-label="Chapter progress"
      title="Click to jump"
    >
      <m.div
        className="relative h-full bg-(--progress-fill)"
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ type: "spring", stiffness: 200, damping: 30 }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-0 size-2.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 shadow-sm transition-opacity duration-300 group-hover/progress:opacity-100"
        />
      </m.div>
    </div>
  )
}

/** The bottom bar, sketchybar-style: one frosted strip with the progress rail
 *  as its top edge, holding four brackets — the app and its actions, then
 *  narration (voice, engine) on the left; the transport in the middle; the
 *  status modules (readout, volume, speed, clock) on the right. It is the
 *  only chrome on screen; everything the top bar held lives here now. */
export function Dock({ showClock, settingsOpen, onSettingsClick, onPasteClick }: Props) {
  const { chunks, idx, engine, switchingTo, blocked } = usePlayer()
  const switchingLabel = useEngineLabel(switchingTo)
  // Deliberately not gated on playback: an engine is nearly always switched
  // from the settings page with the player paused, and that is precisely the
  // switch that used to happen in total silence.
  const statusLine = switchingTo
    ? `switching to ${switchingLabel}…`
    : blocked
      ? "paused — GPU busy (Qwen3 has no CPU mode)"
      : engine?.loading
        ? `loading ${engine.label}…`
        : null
  const working = switchingTo !== null || !!engine?.loading

  return (
    <footer className="fixed inset-x-0 bottom-0 z-20 px-2 pb-2 sm:px-3 sm:pb-3">
      <m.div
        initial={{ y: 18, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 28, delay: 0.04 }}
        className="overflow-hidden rounded-lg border bg-card/85 backdrop-blur"
      >
        <ProgressRail n={chunks.length} idx={idx} />
        {statusLine && (
          <div
            role="status"
            className="flex items-center justify-center gap-1.5 px-3 pt-1.5 font-mono text-[11px] text-muted-foreground"
          >
            {working && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {statusLine}
          </div>
        )}
        {/* Below lg the groups spread with flex so nothing can overlap; from
            lg up the grid pins the transport to the exact center, with the
            two setup brackets on the left and the status bracket on the right
            sized to balance each other. */}
        <div className="flex items-center justify-between gap-1 px-1 py-1.5 sm:gap-2 sm:px-1.5 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <SystemBracket settingsOpen={settingsOpen} onSettingsClick={onSettingsClick} onPasteClick={onPasteClick} />
            <NarrationBracket />
          </div>
          <NowPlaying />
          <StatusBracket showClock={showClock} />
        </div>
      </m.div>
    </footer>
  )
}
