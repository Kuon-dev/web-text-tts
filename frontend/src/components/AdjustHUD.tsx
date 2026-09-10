import { AnimatePresence, m } from "motion/react"
import type { Transition } from "motion/react"
import { Gauge, Volume1, Volume2, VolumeX } from "lucide-react"
import { useHud, type HudKind, type HudState } from "@/lib/hud"
import { SPEED_MAX, SPEED_MIN } from "@/lib/player"
import { cn } from "@/lib/utils"

const PILL_SPRING: Transition = { type: "spring", stiffness: 380, damping: 30 }
const ICON_SPRING: Transition = { type: "spring", stiffness: 600, damping: 22 }

/** Each kind keeps the colour its module wears in the dock, so the pill reads
 *  as the volume or the speed control speaking up, not as a fifth thing on
 *  screen with a palette of its own. */
const TINT: Record<HudKind, string> = { volume: "text-(--mod-volume)", speed: "text-(--mod-speed)" }
const FILL: Record<HudKind, string> = { volume: "bg-(--mod-volume)", speed: "bg-(--mod-speed)" }

/** Same ladder the dock's volume button climbs. */
const volumeIcon = (value: number) => (value === 0 ? VolumeX : value < 0.5 ? Volume1 : Volume2)

/** Where the value sits in its own range, 0..1. Volume already is that; speed
 *  starts at 0.75, so an unmapped bar would never look empty and would be
 *  nearly full at 1×. */
const fraction = ({ kind, value }: HudState) =>
  kind === "volume" ? value : (value - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)

/** The same wording as the dock modules these values belong to. */
const format = ({ kind, value }: HudState) => (kind === "volume" ? `${Math.round(value * 100)}%` : `${value.toFixed(2)}×`)

function Pill({ state }: { state: HudState }) {
  const Icon = state.kind === "volume" ? volumeIcon(state.value) : Gauge

  return (
    <m.div
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.96 }}
      transition={PILL_SPRING}
      className="flex items-center gap-2.5 rounded-lg border bg-card/85 px-3 py-2 shadow-lg backdrop-blur"
    >
      {/* Keyed on seq so the icon replays its pop for every nudge: at either
          end of the range nothing else moves, and without this a key held
          against the ceiling would look like a key that never arrived. */}
      <m.span
        key={state.seq}
        initial={{ scale: 0.82 }}
        animate={{ scale: 1 }}
        transition={ICON_SPRING}
        className={cn("grid place-items-center", TINT[state.kind])}
      >
        <Icon className="size-4" aria-hidden />
      </m.span>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-secondary">
        <m.div
          className={cn("h-full rounded-full", FILL[state.kind])}
          initial={false}
          animate={{ width: `${fraction(state) * 100}%` }}
          transition={PILL_SPRING}
        />
      </div>
      {/* Fixed width and tabular figures: the pill must not resize under a held
          key, or the bar would jitter every time the number changes width. */}
      <span className="w-12 text-right font-mono text-xs tabular-nums">{format(state)}</span>
    </m.div>
  )
}

/**
 * The pill the keyboard nudges speak through: a value a hand is changing has
 * to be visible while it changes, and the dock's own readouts are two small
 * numbers at the far right of the screen — the wrong place to look while both
 * hands are on the keys and the eyes are in the text.
 *
 * aria-hidden throughout: every value here belongs to a dock control that
 * announces itself, so voicing the pill as well would double every nudge.
 */
export function AdjustHUD() {
  const hud = useHud()

  return (
    // The dock is fixed and publishes its height as --dock-h; the pill clears
    // exactly that, the way the toasts do. Centring is a flex row rather than a
    // -translate-x-1/2 on the pill itself, because motion drives the pill's own
    // transform and the two would fight over it.
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 z-20 flex justify-center px-3"
      style={{ bottom: "calc(var(--dock-h) + 0.75rem)" }}
    >
      <AnimatePresence>{hud && <Pill key="pill" state={hud} />}</AnimatePresence>
    </div>
  )
}
