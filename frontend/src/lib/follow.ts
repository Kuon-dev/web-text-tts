import { useEffect, useRef } from "react"
import { animate, motionValue } from "motion"
import type { AnimationPlaybackControls } from "motion"

/** Fraction of the viewport height where the current sentence settles —
 *  slightly above center to sit between the top bar and the player bar. */
const READING_LINE = 0.42

/**
 * Keeps the current sentence on the reading line with a spring glide
 * (motion.dev). Driving a MotionValue lets each retarget inherit the
 * in-flight velocity, so back-to-back sentence advances read as one
 * continuous teleprompter motion instead of restarting an ease curve.
 * Manual scrolling cancels the glide; a document switch repositions
 * instantly.
 */
export function useFollowChunk(idx: number, docId: string, enabled: boolean) {
  const y = useRef(motionValue(0))
  const anim = useRef<AnimationPlaybackControls | null>(null)
  const lastDoc = useRef(docId)

  useEffect(() => {
    const cancel = () => anim.current?.stop()
    window.addEventListener("wheel", cancel, { passive: true })
    window.addEventListener("touchmove", cancel, { passive: true })
    return () => {
      cancel()
      window.removeEventListener("wheel", cancel)
      window.removeEventListener("touchmove", cancel)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const el = document.getElementById(`c${idx}`)
    if (!el) return

    const r = el.getBoundingClientRect()
    const target = window.scrollY + r.top + r.height / 2 - window.innerHeight * READING_LINE
    const newDoc = lastDoc.current !== docId
    lastDoc.current = docId

    if (Math.abs(target - window.scrollY) < 2) {
      anim.current?.stop()
      return
    }

    if (newDoc || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      anim.current?.stop()
      window.scrollTo(0, target)
      return
    }

    const mv = y.current
    // If something else moved the page since our last frame (user scroll,
    // first glide), resync without inheriting stale velocity.
    if (Math.abs(mv.get() - window.scrollY) > 1) mv.jump(window.scrollY)

    // Slightly overdamped: settles firmly on the reading line, no overshoot.
    anim.current = animate(mv, target, {
      type: "spring",
      stiffness: 110,
      damping: 24,
      mass: 1,
      restDelta: 0.5,
      onUpdate: (v) => window.scrollTo(0, v),
    })
  }, [idx, docId, enabled])
}
