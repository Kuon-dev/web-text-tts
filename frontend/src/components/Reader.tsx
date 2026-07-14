import { useMemo, useState } from "react"
import { BookOpenText, ClipboardPaste } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"
import { useFollowChunk } from "@/lib/follow"
import { player, usePlayer } from "@/lib/player"
import { FONT_STACKS, type ReadingPrefs } from "@/lib/reading"
import { cn } from "@/lib/utils"
import type { Chunk } from "@/lib/api"

interface Props {
  prefs: ReadingPrefs
  onPasteClick: () => void
}

interface Para {
  para: number
  items: { chunk: Chunk; i: number }[]
}

export function Reader({ prefs, onPasteClick }: Props) {
  const { docId, chunks, idx, ready, failed } = usePlayer()

  // Track the previously focused sentence so the one the voice just left
  // can fade out slower than the new one fades in (trailing highlight).
  const [trackedIdx, setTrackedIdx] = useState(idx)
  const [prevIdx, setPrevIdx] = useState(-1)
  if (trackedIdx !== idx) {
    setPrevIdx(trackedIdx)
    setTrackedIdx(idx)
  }

  const paras = useMemo<Para[]>(() => {
    const groups: Para[] = []
    chunks.forEach((chunk, i) => {
      const last = groups[groups.length - 1]
      if (!last || last.para !== chunk.para) groups.push({ para: chunk.para, items: [{ chunk, i }] })
      else last.items.push({ chunk, i })
    })
    return groups
  }, [chunks])

  useFollowChunk(idx, docId, prefs.autoScroll && chunks.length > 0)

  if (!chunks.length) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-28 text-center animate-in fade-in zoom-in-95 duration-500 motion-reduce:animate-none">
        <div className="flex size-14 items-center justify-center rounded-lg border bg-card text-muted-foreground">
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
      </main>
    )
  }

  return (
    <main
      key={docId}
      className="mx-auto w-full flex-1 px-5 pt-10 pb-[50vh]"
      style={{
        fontFamily: FONT_STACKS[prefs.font],
        fontSize: `${prefs.size}px`,
        lineHeight: prefs.lineHeight,
        maxWidth: `${prefs.width}rem`,
        textAlign: prefs.justify ? "justify" : undefined,
      }}
    >
      {paras.map((p, pi) => (
        <m.p
          key={p.para}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 120, damping: 20, delay: Math.min(pi * 0.04, 0.4) }}
          style={{ marginBottom: `${prefs.paraSpacing}em` }}
        >
          {p.items.map(({ chunk, i }) => (
            <span
              key={i}
              id={`c${i}`}
              onClick={() => player.clickChunk(i)}
              className={cn(
                "cursor-pointer rounded-sm box-decoration-clone px-0.5 transition-[background-color,color,box-shadow]",
                i === prevIdx && i !== idx ? "duration-700" : "duration-200",
                i === idx
                  ? cn("hl-current text-foreground", !ready.has(chunk.id) && !failed.has(chunk.id) && "hl-buffering")
                  : failed.has(chunk.id)
                    ? "text-destructive underline decoration-dotted underline-offset-4 hover:bg-accent/50"
                    : ready.has(chunk.id)
                      ? "text-foreground/85 hover:bg-accent/50"
                      : "text-muted-foreground/70 hover:bg-accent/50",
              )}
            >
              {chunk.text + " "}
            </span>
          ))}
        </m.p>
      ))}
    </main>
  )
}
