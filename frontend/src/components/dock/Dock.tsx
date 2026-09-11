import { useLayoutEffect, useRef } from "react"
import type { MouseEvent } from "react"
import { m } from "motion/react"
import { player, usePlayer } from "@/lib/player"
import type { Mark } from "@/lib/bookmarks"
import { NarrationBracket, StatusBracket } from "./Modules"
import { NowPlaying } from "./NowPlaying"
import { SystemBracket } from "./SystemBracket"

interface Props {
  showClock: boolean
  settingsOpen: boolean
  onSettingsClick: () => void
  onPasteClick: () => void
}

/** How close a click must land to a tick to mean that mark rather than the
 *  sentence under the pixel. The rail is 4px tall, so the ticks are far too
 *  small to be hit targets of their own — the rail snaps instead. When two
 *  marks fall within 2×SNAP_PX of each other, snap picks the nearest, not the
 *  first — a click at the later mark lands on it, not the earlier one. */
const SNAP_PX = 6

/** Chapter progress as the bar's top edge; click anywhere on it to jump.
 *  Bookmarks ride it as ticks, so the marks in a chapter are visible without
 *  opening anything. */
function ProgressRail({ n, idx, marks }: { n: number; idx: number; marks: readonly Mark[] }) {
  const pct = n ? ((idx + 1) / n) * 100 : 0
  const at = (chunk: number) => (n > 1 ? (chunk / (n - 1)) * 100 : 0)
  const scrub = (e: MouseEvent<HTMLDivElement>) => {
    if (!n) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const near = marks.reduce<{ chunk: number; d: number } | null>((best, m) => {
      const d = Math.abs((at(m.chunk) / 100) * r.width - x)
      return d <= SNAP_PX && (!best || d < best.d) ? { chunk: m.chunk, d } : best
    }, null)
    player.jump(near ? near.chunk : Math.round((x / r.width) * (n - 1)))
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
      {/* After the fill, so a tick inside the read-so-far stretch still reads.
          Neutral rather than accented: the five --ac-* slots belong to the dock
          modules and --accent-base is playback state. */}
      {marks.map((m) => (
        <div
          key={m.chunk}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground/45"
          style={{ left: `${at(m.chunk)}%` }}
        />
      ))}
    </div>
  )
}

/** The bottom bar, sketchybar-style: one frosted strip with the progress rail
 *  as its top edge, holding four brackets — the app and its actions, then
 *  narration (voice, engine) on the left; the transport in the middle; the
 *  status modules (readout, volume, speed, clock) on the right. It is the
 *  only chrome on screen; everything the top bar held lives here now. */
export function Dock({ showClock, settingsOpen, onSettingsClick, onPasteClick }: Props) {
  const { chunks, idx, bookmarks } = usePlayer()

  // The dock is fixed, so nothing else can size itself around it. It
  // publishes its height (bar plus the gap under it) as --dock-h on <html>;
  // the settings window and the toasts keep clear of exactly that much.
  const footerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = footerRef.current
    if (!el) return
    const root = document.documentElement
    const ro = new ResizeObserver(() => root.style.setProperty("--dock-h", `${el.offsetHeight}px`))
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty("--dock-h")
    }
  }, [])

  return (
    <footer ref={footerRef} className="fixed inset-x-0 bottom-0 z-20 px-2 pb-2 sm:px-3 sm:pb-3">
      <m.div
        initial={{ y: 18, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 28, delay: 0.04 }}
        className="overflow-hidden rounded-lg border bg-card/85 backdrop-blur"
      >
        <ProgressRail n={chunks.length} idx={idx} marks={bookmarks} />
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
