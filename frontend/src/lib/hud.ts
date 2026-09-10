import { useSyncExternalStore } from "react"

export type HudKind = "volume" | "speed"

export interface HudState {
  kind: HudKind
  value: number
  /** Bumped by every show(). A nudge that changes nothing — leaning on Shift+↑
   *  once the volume is already at 100% — still hands React a fresh snapshot,
   *  so the pill replays its animation instead of sitting there looking as if
   *  the key had not arrived. */
  seq: number
}

/** How long the pill stays up after the last nudge. Long enough to read the
 *  number after a single tap, short enough that it is gone before the eye
 *  goes looking for the sentence it was covering. */
const HOLD_MS = 1200

/**
 * The transient volume/speed readout, in the same shape as player.ts's store
 * so both are consumed the same way. It lives outside React because the thing
 * that writes to it is a bare document keydown listener with no component of
 * its own, and the pill that reads it is mounted somewhere else entirely.
 */
class HudStore {
  private snap: HudState | null = null
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snap

  /** Show a value, restarting the hold. Every call restarts it, so a held key
   *  keeps the pill up for the whole ramp and only starts counting down once
   *  the hand comes off. */
  show(kind: HudKind, value: number) {
    this.seq += 1
    this.snap = { kind, value, seq: this.seq }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.hide(), HOLD_MS)
    this.emit()
  }

  /** Take the pill down now. The component keeps painting the last value
   *  through its exit animation, so this can drop the state immediately. */
  hide() {
    clearTimeout(this.timer)
    this.snap = null
    this.emit()
  }

  private emit() {
    this.listeners.forEach((fn) => fn())
  }
}

export const hud = new HudStore()

export function useHud(): HudState | null {
  return useSyncExternalStore(hud.subscribe, hud.getSnapshot)
}
