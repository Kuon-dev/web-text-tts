import { useRef } from "react"
import { createPortal } from "react-dom"
import { Bookmark, BookmarkX, Copy, Play } from "lucide-react"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { player } from "@/lib/player"

const COPY_TOAST = "copy-sentence"

/** A sentence the pointer landed on, with the pointer in viewport coordinates. */
export interface ChunkTarget {
  x: number
  y: number
  /** Index into the document's flat chunk array — one chunk is one sentence. */
  chunk: number
  text: string
  marked: boolean
}

interface Props {
  /** The sentence to act on, or null when the menu should be shut. */
  target: ChunkTarget | null
  onClose: () => void
  /** Where focus goes when the menu closes. See `onCloseAutoFocus` below. */
  onRestoreFocus: () => void
}

async function copySentence(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.message("Sentence copied", { id: COPY_TOAST, duration: 1600 })
  } catch {
    // Outside a secure context `navigator.clipboard` is undefined, so reading
    // `.writeText` off it throws here as well — one catch covers the missing
    // API and the refused write alike.
    toast.error("Could not copy — the clipboard needs https or localhost", { id: COPY_TOAST })
  }
}

/**
 * The reader's right-click menu: bookmark, play, or copy the sentence under the
 * pointer.
 *
 * One menu for the whole chapter, not one per sentence. The reader renders a
 * span per sentence — ~10k of them — so a Radix `ContextMenu` around each would
 * mint thousands of menu roots for a gesture that can only ever address one
 * line at a time. The reader resolves which sentence was hit and hands it here.
 */
export function ChunkContextMenu({ target, onClose, onRestoreFocus }: Props) {
  // The menu animates out (`data-closed:animate-out`), so Radix keeps it
  // mounted for a beat after `target` goes null. Drawing the rows from the last
  // target stops them blanking mid-fade.
  const last = useRef<ChunkTarget | null>(null)
  if (target) last.current = target
  const t = target ?? last.current
  if (!t) return null

  return createPortal(
    <DropdownMenu open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Radix positions a menu against its trigger, so the trigger here is a
          zero-size marker parked where the pointer was. It is portaled onto
          <body> because `position: fixed` resolves against the nearest
          containing block and the reader supplies two — the scroll pane's
          `container-type: size` and the tile's animated transform. Rendered
          inside either, these viewport coordinates would land elsewhere. */}
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed" style={{ left: t.x, top: t.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={2}
        // The shared content takes its width from the trigger, and this trigger
        // is zero wide.
        className="w-auto"
        // Radix would return focus to that zero-size marker, taking it off the
        // scroll pane and leaving ↑/↓/PageDown dead until something else is
        // clicked. Hand it back to the pane instead.
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onRestoreFocus()
        }}
      >
        {/* No shortcut hint on this row: `b` marks the sentence being *read*,
            which is rarely the one under the pointer. */}
        <DropdownMenuItem onSelect={() => player.toggleBookmark(t.chunk)}>
          {t.marked ? <BookmarkX aria-hidden /> : <Bookmark aria-hidden />}
          {t.marked ? "Remove bookmark" : "Bookmark this sentence"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.clickChunk(t.chunk)}>
          <Play aria-hidden />
          Play from here
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copySentence(t.text)}>
          <Copy aria-hidden />
          Copy sentence
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body,
  )
}
