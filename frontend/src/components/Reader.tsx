import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { BookOpenText, ClipboardPaste } from "lucide-react"
import { m } from "motion/react"
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
  const { docId, chunks, images, idx, playing, ready, failed } = usePlayer()

  // Track the previously focused sentence so the one the voice just left
  // can fade out slower than the new one fades in (trailing highlight).
  const [trackedIdx, setTrackedIdx] = useState(idx)
  const [prevIdx, setPrevIdx] = useState(-1)
  if (trackedIdx !== idx) {
    setPrevIdx(trackedIdx)
    setTrackedIdx(idx)
  }

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

  useFollowChunk(idx, docId, prefs.autoScroll && chunks.length > 0)

  if (!chunks.length && !images.length) {
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
    <main key={docId} className="w-full flex-1 px-2 pt-2 pb-[50vh] sm:px-3 sm:pt-3">
      {/* The reader is the session's "focused window": the accent border and
          glow are on exactly while the voice is reading. */}
      <m.div
        initial={{ opacity: 0, scale: 0.985, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 180, damping: 24, delay: 0.06 }}
        className={cn(
          "mx-auto rounded-lg border bg-card/85 backdrop-blur-sm transition-[border-color,box-shadow] duration-700",
          playing ? "border-(--focus-border) shadow-[0_0_44px_-10px_var(--focus-glow)]" : "shadow-sm",
        )}
        style={{ maxWidth: `min(100%, ${readerMaxWidth(prefs.width)}px)` }}
      >
        <div
          className={cn("px-5 py-8 sm:px-10 sm:py-10", entering && "rd-enter")}
          style={{
            fontFamily: FONT_STACKS[prefs.font],
            fontSize: `${prefs.size}px`,
            lineHeight: prefs.lineHeight,
            textAlign: prefs.justify ? "justify" : undefined,
          }}
        >
      {blocks.map((p, pi) =>
        p.kind === "image" ? (
          <figure
            key={`img-${p.para}`}
            style={{ marginBottom: `${prefs.paraSpacing}em`, ...stagger(pi) }}
          >
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
        <p
          key={p.para}
          style={{ marginBottom: `${prefs.paraSpacing}em`, ...stagger(pi) }}
        >
          {p.items.map(({ chunk, i }) => (
            <span
              key={i}
              id={`c${i}`}
              onClick={() => player.clickChunk(i)}
              className={cn(
                "rd-chunk cursor-pointer rounded-sm box-decoration-clone px-0.5",
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
      </m.div>
    </main>
  )
}
