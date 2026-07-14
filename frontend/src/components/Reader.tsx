import { useEffect, useMemo } from "react"
import { BookOpenText, ClipboardPaste } from "lucide-react"
import { Button } from "@/components/ui/button"
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

  const paras = useMemo<Para[]>(() => {
    const groups: Para[] = []
    chunks.forEach((chunk, i) => {
      const last = groups[groups.length - 1]
      if (!last || last.para !== chunk.para) groups.push({ para: chunk.para, items: [{ chunk, i }] })
      else last.items.push({ chunk, i })
    })
    return groups
  }, [chunks])

  useEffect(() => {
    document.getElementById(`c${idx}`)?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [idx, docId])

  if (!chunks.length) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-28 text-center">
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
      className="mx-auto w-full flex-1 px-5 pt-10 pb-[50vh]"
      style={{
        fontFamily: FONT_STACKS[prefs.font],
        fontSize: `${prefs.size}px`,
        lineHeight: prefs.lineHeight,
        maxWidth: `${prefs.width}rem`,
      }}
    >
      {paras.map((p) => (
        <p key={p.para} className="mb-[1.1em]">
          {p.items.map(({ chunk, i }) => (
            <span
              key={i}
              id={`c${i}`}
              onClick={() => player.clickChunk(i)}
              className={cn(
                "cursor-pointer rounded-sm box-decoration-clone px-0.5 transition-colors duration-150",
                i === idx
                  ? "bg-indigo-500/25 text-zinc-50 ring-1 ring-indigo-400/40"
                  : failed.has(chunk.id)
                    ? "text-red-400 underline decoration-dotted underline-offset-4 hover:bg-accent/50"
                    : ready.has(chunk.id)
                      ? "text-foreground/85 hover:bg-accent/50"
                      : "text-muted-foreground/70 hover:bg-accent/50",
              )}
            >
              {chunk.text + " "}
            </span>
          ))}
        </p>
      ))}
    </main>
  )
}
