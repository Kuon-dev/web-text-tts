import { useEffect, useRef } from "react"
import { animate, motionValue } from "motion"
import type { AnimationPlaybackControls } from "motion"

/** Fraction of the viewport height where the current sentence settles —
 *  slightly above center, so it sits well clear of the dock at the bottom. */
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
    // The chapter-entrance stagger translates paragraphs (y: 10 -> 0) and
    // rects include that transform; subtract the residual so we target the
    // sentence's final resting position, not where it is mid-entrance.
    let tfY = 0
    const p = el.closest("p")
    if (p) {
      const tf = getComputedStyle(p).transform
      if (tf && tf !== "none") tfY = new DOMMatrixReadOnly(tf).m42
    }
    const target = window.scrollY + r.top - tfY + r.height / 2 - window.innerHeight * READING_LINE
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

    // Critically damped and fairly stiff: the glide must lead the eye to the
    // new sentence quickly (springs start at zero velocity, so a soft spring
    // leaves the page static right when the highlight moves rows), then
    // settle without overshoot.
    anim.current = animate(mv, target, {
      type: "spring",
      stiffness: 170,
      damping: 26,
      mass: 1,
      restDelta: 0.5,
      onUpdate: (v) => window.scrollTo(0, v),
    })
  }, [idx, docId, enabled])
}
