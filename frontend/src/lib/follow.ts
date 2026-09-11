import { useEffect, useRef, useState, type RefObject } from "react"
import { animate, motionValue } from "motion"
import type { AnimationPlaybackControls } from "motion"

/** Fraction of the panel's height where the current sentence settles —
 *  slightly above center, where the eye rests on a page of prose. */
const READING_LINE = 0.42

/**
 * The element's top edge in `root`'s scroll coordinates, from layout
 * positions rather than client rects: rects include transforms, and both the
 * chapter-entrance rise and the tile's arrival spring are transforms, so a
 * rect measured mid-animation would aim the glide at where the sentence is,
 * not where it will rest. Summed up the offsetParent chain rather than read
 * off one offsetTop because engines disagree on whether a transformed
 * ancestor counts as an offsetParent; the sum is right either way.
 */
function topWithin(el: HTMLElement, root: HTMLElement): number {
  let y = 0
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) y += n.offsetTop
  return y
}

/**
 * Keeps the current sentence on the reading line of the chapter panel with a
 * spring glide (motion.dev). Driving a MotionValue lets each retarget inherit
 * the in-flight velocity, so back-to-back sentence advances read as one
 * continuous teleprompter motion instead of restarting an ease curve.
 * Manual scrolling cancels the glide; a document switch repositions
 * instantly. `scroller` is the panel that scrolls — the reader's pane, which
 * must be positioned so the sentences' offsets are measured against it.
 */
export function useFollowChunk(idx: number, docId: string, enabled: boolean, scroller: RefObject<HTMLElement | null>) {
  const y = useRef(motionValue(0))
  const anim = useRef<AnimationPlaybackControls | null>(null)
  const lastDoc = useRef(docId)

  // On a cold cache the chapter is laid out in the fallback font first, and
  // the web font swaps in a frame later — before the first paint, but after
  // the effect below has measured. The swap stretches the text by a couple of
  // percent, which sixty thousand pixels into a chapter is more than a screen,
  // and nothing else would re-aim. A finished font load does — but only when
  // it reflowed the chapter (its scroll height moved since the last aim): the
  // dock and the dialogs load fonts of their own, and a reader who has
  // scrolled ahead must not be yanked back because a clock glyph arrived.
  const [reflow, setReflow] = useState(0)
  const aimedHeight = useRef(0)
  useEffect(() => {
    const onFonts = () => {
      const sc = scroller.current
      if (sc && sc.scrollHeight !== aimedHeight.current) setReflow((n) => n + 1)
    }
    document.fonts.addEventListener("loadingdone", onFonts)
    return () => document.fonts.removeEventListener("loadingdone", onFonts)
  }, [scroller])

  useEffect(() => {
    const cancel = () => anim.current?.stop()
    // On the window, not the panel: a wheel over the tile's gutters is
    // forwarded into the panel by the reader and must cancel the glide too.
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
    const sc = scroller.current
    const el = document.getElementById(`c${idx}`)
    if (!sc || !el) return
    aimedHeight.current = sc.scrollHeight

    const line = topWithin(el, sc) + el.offsetHeight / 2 - sc.clientHeight * READING_LINE
    // Clamped so the "already there" test below is honest at either end of
    // the chapter, where the browser would clamp the scroll anyway.
    const target = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, line))
    const newDoc = lastDoc.current !== docId
    lastDoc.current = docId

    if (Math.abs(target - sc.scrollTop) < 2) {
      anim.current?.stop()
      return
    }

    if (newDoc || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      anim.current?.stop()
      sc.scrollTop = target
      return
    }

    const mv = y.current
    // If something else moved the panel since our last frame (user scroll,
    // the restore after settings), resync without inheriting stale velocity.
    if (Math.abs(mv.get() - sc.scrollTop) > 1) mv.jump(sc.scrollTop)

    // Critically damped and fairly stiff: the glide must lead the eye to the
    // new sentence quickly (springs start at zero velocity, so a soft spring
    // leaves the panel static right when the highlight moves rows), then
    // settle without overshoot.
    anim.current = animate(mv, target, {
      type: "spring",
      stiffness: 170,
      damping: 26,
      mass: 1,
      restDelta: 0.5,
      onUpdate: (v) => {
        sc.scrollTop = v
      },
    })
  }, [idx, docId, enabled, scroller, reflow])
}
