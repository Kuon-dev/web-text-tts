import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type WheelEvent } from "react"
import { BookOpenText, ClipboardPaste } from "lucide-react"
import { m } from "motion/react"
import { ChunkContextMenu, type ChunkTarget } from "@/components/ChunkContextMenu"
import { TILE_FRAME } from "@/components/tile"
import { Button } from "@/components/ui/button"
import { imageUrl, type Chunk, type ImageRef } from "@/lib/api"
import { useFollowChunk } from "@/lib/follow"
import { player, usePlayer } from "@/lib/player"
import { FONT_STACKS, readerMaxWidth, type ReadingPrefs } from "@/lib/reading"
import { cn } from "@/lib/utils"

interface Props {
  prefs: ReadingPrefs
  onPasteClick: () => void
}

/**
 * The chapter whose entrance has already played. Module scope rather than a
 * ref because the reader unmounts while the settings page is up: a per-instance
 * ref would forget, and every trip back from settings would replay the whole
 * chapter entrance — thousands of paragraphs animating at once, which is the
 * stutter this exists to avoid.
 */
let enteredDoc: string | null = null

/**
 * Where the chapter panel was scrolled to when the reader last unmounted, and
 * for which chapter. Module scope for the same reason as `enteredDoc`: the
 * settings page replaces the reader, and coming back should land on the same
 * line, not at the top of the chapter.
 */
let savedScroll: { doc: string; top: number } | null = null

type Block =
  | { kind: "text"; para: number; items: { chunk: Chunk; i: number }[] }
  | { kind: "image"; para: number; img: ImageRef }

/** Entrance delay for the top of the chapter. Past the tenth block every
 *  delay was already the same 0.4s cap, so only the first ten need to say so
 *  and the rest inherit the cap from the stylesheet. */
function stagger(pi: number): CSSProperties | undefined {
  return pi < 10 ? ({ "--rd-d": `${pi * 0.04}s` } as CSSProperties) : undefined
}

export function Reader({ prefs, onPasteClick }: Props) {
  const { docId, chunks, images, idx, playing, ready, failed, bookmarkSet } = usePlayer()
  const empty = !chunks.length && !images.length

  // Track the previously focused sentence so the one the voice just left
  // can fade out slower than the new one fades in (trailing highlight).
  const [trackedIdx, setTrackedIdx] = useState(idx)
  const [prevIdx, setPrevIdx] = useState(-1)
  if (trackedIdx !== idx) {
    setPrevIdx(trackedIdx)
    setTrackedIdx(idx)
  }

  // The sentence the right-click menu is open on, or null when it is shut.
  const [menuTarget, setMenuTarget] = useState<ChunkTarget | null>(null)

  const blocks = useMemo<Block[]>(() => {
    const groups: Block[] = []
    chunks.forEach((chunk, i) => {
      const last = groups[groups.length - 1]
      if (!last || last.kind !== "text" || last.para !== chunk.para) {
        groups.push({ kind: "text", para: chunk.para, items: [{ chunk, i }] })
      } else {
        last.items.push({ chunk, i })
      }
    })
    // A marker paragraph is its own para index, so images interleave cleanly.
    images.forEach((img) => groups.push({ kind: "image", para: img.para, img }))
    groups.sort((a, b) => a.para - b.para)
    return groups
  }, [chunks, images])

  // The entrance belongs to a chapter arriving, not to this component
  // mounting. Decided once per document and held in a ref so the double render
  // under StrictMode and every playback tick all see the same answer.
  const entrance = useRef<{ doc: string; on: boolean }>({ doc: docId, on: enteredDoc !== docId })
  if (entrance.current.doc !== docId) entrance.current = { doc: docId, on: enteredDoc !== docId }
  const entering = entrance.current.on
  useLayoutEffect(() => {
    enteredDoc = docId
  }, [docId])

  // The pane that scrolls. The tile is the viewport's height, like settings,
  // so the chapter scrolls inside it and the page never moves.
  const scroller = useRef<HTMLDivElement>(null)

  // The scroll offset survives the settings round trip. Restored in a layout
  // effect so it is in place before useFollowChunk's passive effect runs — that
  // effect then glides at most the distance playback advanced. Saved in the
  // cleanup, which React runs before the pane leaves the DOM, while scrollTop
  // still means something. Keyed on the pane's existence as well as the
  // chapter, because the empty state has no pane to restore into.
  useLayoutEffect(() => {
    const sc = scroller.current
    if (!sc) return
    if (savedScroll?.doc === docId) sc.scrollTop = savedScroll.top
    return () => {
      savedScroll = { doc: docId, top: sc.scrollTop }
    }
  }, [docId, empty])

  // ↑/↓, PageDown and Home/End scroll whatever holds focus, and that used to
  // be the document. Now it has to be the pane, so it takes focus whenever
  // nothing else has it: at load, and again when settings hands back. Never
  // from a dialog or a dock control — those own their keys.
  useEffect(() => {
    const sc = scroller.current
    if (sc && (!document.activeElement || document.activeElement === document.body)) sc.focus({ preventScroll: true })
  }, [docId, empty])

  useFollowChunk(idx, docId, prefs.autoScroll && !empty, scroller)

  // A wheel over the tile's gutters scrolls the chapter too. The page itself
  // no longer scrolls, and a column that goes dead a pixel outside its border
  // would feel broken in an app that is mostly scrolling.
  const onWheel = (e: WheelEvent<HTMLElement>) => {
    const sc = scroller.current
    if (!sc || sc.contains(e.target as Node)) return
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1
    sc.scrollBy({ top: e.deltaY * unit })
  }

  // Right-click on a sentence opens our menu; anywhere else the browser's own
  // menu is left alone, so an illustration keeps "Save image as…" and the
  // gutters behave normally. One listener on the pane rather than one per
  // span: at ~10k sentences, per-span handlers are the cost this avoids.
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    const span = (e.target as HTMLElement).closest?.("[data-chunk]")
    if (!span) return
    const i = Number(span.getAttribute("data-chunk"))
    const chunk = chunks[i]
    if (!chunk) return
    e.preventDefault()
    setMenuTarget({ x: e.clientX, y: e.clientY, chunk: i, text: chunk.text, marked: bookmarkSet.has(i) })
  }

  if (empty) {
    return (
      <main className="flex flex-1 px-2 pb-28 sm:px-3">
        <m.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 24, delay: 0.08 }}
          className="m-auto flex w-full max-w-md flex-col items-center gap-5 rounded-lg border bg-card/85 px-8 py-14 text-center shadow-sm backdrop-blur-sm"
        >
          <div className="flex size-14 items-center justify-center rounded-lg border bg-background/60 text-muted-foreground">
            <BookOpenText className="size-6" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold">No chapter loaded</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Paste a chapter and it will be read aloud, with the current sentence highlighted as it goes.
            </p>
          </div>
          <Button onClick={onPasteClick}>
            <ClipboardPaste data-icon="inline-start" aria-hidden />
            Paste chapter
          </Button>
        </m.div>
      </main>
    )
  }

  return (
    <main key={docId} className={TILE_FRAME} onWheel={onWheel}>
      {/* The reader is the session's "focused window": the accent border and
          glow are on exactly while the voice is reading. */}
      <m.div
        initial={{ opacity: 0, scale: 0.985, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 180, damping: 24, delay: 0.06 }}
        className={cn(
          "mx-auto flex h-full flex-col overflow-hidden rounded-lg border bg-card/85 backdrop-blur-sm transition-[border-color,box-shadow] duration-700",
          playing ? "border-(--focus-border) shadow-[0_0_44px_-10px_var(--focus-glow)]" : "shadow-sm",
        )}
        style={{ maxWidth: `min(100%, ${readerMaxWidth(prefs.width)}px)` }}
      >
        {/* Only this pane scrolls. It is positioned so useFollowChunk can
            measure sentences against it, and a size query container so the
            tail padding below can be a fraction of its height. */}
        <div
          ref={scroller}
          tabIndex={0}
          onContextMenu={onContextMenu}
          className="relative min-h-0 flex-1 overflow-y-auto outline-none [container-type:size] [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
          {/* The tail lets the last sentence reach the reading line: with the
              line 42% of the way down the pane, 58% of the pane lies below it. */}
          <div
            className={cn("px-5 pt-8 pb-[58cqh] sm:px-10 sm:pt-10", entering && "rd-enter")}
            style={{
              fontFamily: FONT_STACKS[prefs.font],
              fontSize: `${prefs.size}px`,
              lineHeight: prefs.lineHeight,
              textAlign: prefs.justify ? "justify" : undefined,
            }}
          >
            {blocks.map((p, pi) =>
              p.kind === "image" ? (
                <figure key={`img-${p.para}`} style={{ marginBottom: `${prefs.paraSpacing}em`, ...stagger(pi) }}>
                  <a href={imageUrl(p.img.id)} target="_blank" rel="noreferrer" title="Open full size">
                    <img
                      src={imageUrl(p.img.id)}
                      width={p.img.w}
                      height={p.img.h}
                      alt=""
                      loading="lazy"
                      className="mx-auto h-auto max-w-full rounded-md"
                    />
                  </a>
                </figure>
              ) : (
                <p key={p.para} style={{ marginBottom: `${prefs.paraSpacing}em`, ...stagger(pi) }}>
                  {p.items.map(({ chunk, i }) => (
                    <span
                      key={i}
                      id={`c${i}`}
                      data-chunk={i}
                      // A Mac ctrl-click reaches the two engines differently:
                      // Chromium sends contextmenu alone and swallows the
                      // click (measured over CDP), while WebKit — the desktop
                      // app's engine — is reported to send both. The guard is
                      // inert on the first and keeps the second from jumping
                      // the voice as the menu opens.
                      onClick={(e) => !e.ctrlKey && player.clickChunk(i)}
                      className={cn(
                        "rd-chunk cursor-pointer rounded-sm box-decoration-clone px-0.5",
                        bookmarkSet.has(i) && "rd-marked",
                        i === prevIdx && i !== idx && "hl-leave",
                        i === idx
                          ? cn("hl-current text-foreground", !ready.has(chunk.id) && !failed.has(chunk.id) && "hl-buffering")
                          : failed.has(chunk.id)
                            ? "text-destructive underline decoration-dotted underline-offset-4"
                            : ready.has(chunk.id)
                              ? "text-foreground/85"
                              : "text-muted-foreground/70",
                      )}
                    >
                      {chunk.text + " "}
                    </span>
                  ))}
                </p>
              ),
            )}
          </div>
        </div>
      </m.div>
      <ChunkContextMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onRestoreFocus={() => scroller.current?.focus({ preventScroll: true })}
      />
    </main>
  )
}
