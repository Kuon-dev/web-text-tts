import { useEffect, useState } from "react"
import type { ClipboardEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { importImageUrl, uploadImage, type ImageInfo } from "@/lib/api"
import { htmlChapter, imgPlaceholder } from "@/lib/paste"
import { player } from "@/lib/player"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

async function importOne(src: string): Promise<ImageInfo | null> {
  try {
    if (src.startsWith("data:image/")) {
      const blob = await (await fetch(src)).blob()
      return await uploadImage(blob)
    }
    return await importImageUrl(src)
  } catch {
    return null
  }
}

export function PasteDialog({ open, onOpenChange }: Props) {
  const [text, setText] = useState("")
  const [importing, setImporting] = useState(0)

  useEffect(() => {
    if (open) setText("")
  }, [open])

  const insertAt = (start: number, end: number, inserted: string) => {
    setText((t) => t.slice(0, start) + inserted + t.slice(end))
  }

  /** Chapter copied from a web page: keep its illustrations as [img:…] lines. */
  const importHtml = async (html: string, ta: HTMLTextAreaElement) => {
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const { text: parsed, urls } = htmlChapter(html)
    if (!urls.length) {
      insertAt(start, end, parsed)
      return
    }
    setImporting((n) => n + 1)
    const tid = toast.loading(`Importing ${urls.length} image${urls.length > 1 ? "s" : ""}…`)
    try {
      const results = await Promise.all(urls.map(importOne))
      let final = parsed
      results.forEach((r, i) => {
        final = final.replace(imgPlaceholder(i), r ? `[img:${r.id}]` : "")
      })
      final = final.replace(/\n{3,}/g, "\n\n").trim()
      insertAt(start, end, final)
      const failed = results.filter((r) => !r).length
      if (failed) toast.error(`${failed} of ${urls.length} image${urls.length > 1 ? "s" : ""} could not be imported`, { id: tid })
      else toast.success(`Imported ${urls.length} image${urls.length > 1 ? "s" : ""}`, { id: tid })
    } finally {
      setImporting((n) => n - 1)
    }
  }

  /** Image data on the clipboard (copy image / screenshot). */
  const importBlobs = async (blobs: File[], ta: HTMLTextAreaElement) => {
    const start = ta.selectionStart
    const end = ta.selectionEnd
    setImporting((n) => n + 1)
    const tid = toast.loading(`Importing ${blobs.length} image${blobs.length > 1 ? "s" : ""}…`)
    try {
      const results = await Promise.all(blobs.map((b) => uploadImage(b).catch(() => null)))
      const markers = results.filter((r): r is ImageInfo => r !== null).map((r) => `[img:${r.id}]`)
      if (markers.length) insertAt(start, end, `\n${markers.join("\n\n")}\n`)
      const failed = results.length - markers.length
      if (failed) toast.error(`${failed} image${failed > 1 ? "s" : ""} could not be imported`, { id: tid })
      else toast.success(`Imported ${markers.length} image${markers.length > 1 ? "s" : ""}`, { id: tid })
    } finally {
      setImporting((n) => n - 1)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData
    const files = Array.from(cd.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length) {
      e.preventDefault()
      void importBlobs(files, e.currentTarget)
      return
    }
    const html = cd.getData("text/html")
    if (html && /<img[\s>]/i.test(html)) {
      e.preventDefault()
      void importHtml(html, e.currentTarget)
    }
    // plain text falls through to the default paste
  }

  const submit = async () => {
    const t = text.trim()
    onOpenChange(false)
    if (!t) return
    if (!(await player.pasteText(t))) {
      toast.error("Failed to load chapter — is the server running?")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste chapter text</DialogTitle>
          <DialogDescription>
            Replaces the current chapter; illustrations in the copied selection are kept. Each chapter's position is
            remembered — re-pasting an earlier one resumes where you left off.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Paste the chapter here…"
          className="h-[50vh] resize-none font-sans text-[15px] leading-relaxed"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!text.trim() || importing > 0}>
            {importing > 0 ? "Importing images…" : "Load & play"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
