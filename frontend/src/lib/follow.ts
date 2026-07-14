import { useEffect, useRef } from "react"

/** Fraction of the viewport height where the current sentence settles —
 *  slightly above center to sit between the top bar and the player bar. */
const READING_LINE = 0.42

/**
 * Keeps the current sentence on the reading line with an eased glide.
 * Native smooth scrollIntoView snaps on short distances (every sentence
 * advance), which is what made following feel mechanical. Manual scrolling
 * cancels an in-flight glide; a document switch repositions instantly.
 */
export function useFollowChunk(idx: number, docId: string, enabled: boolean) {
  const raf = useRef(0)
  const lastDoc = useRef(docId)

  useEffect(() => {
    const cancel = () => cancelAnimationFrame(raf.current)
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

    cancelAnimationFrame(raf.current)
    const newDoc = lastDoc.current !== docId
    lastDoc.current = docId

    const r = el.getBoundingClientRect()
    const start = window.scrollY
    const target = start + r.top + r.height / 2 - window.innerHeight * READING_LINE
    const dist = target - start
    if (Math.abs(dist) < 2) return

    if (newDoc || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo(0, target)
      return
    }

    // ~330ms for a one-line step, capped at 800ms for long jumps
    const duration = Math.min(800, 320 + Math.abs(dist) * 0.35)
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      window.scrollTo(0, start + dist * eased)
      if (t < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }, [idx, docId, enabled])
}
