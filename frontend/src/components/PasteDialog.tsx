import { useEffect, useMemo, useRef, useState } from "react"
import type { ClipboardEvent } from "react"
import { ClipboardPaste, Eraser } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { stripWatermarks } from "@/lib/watermark"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Rough audiobook pace used for the listen-time estimate (words / minute). */
const WPM = 165

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
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) setText("")
  }, [open])

  const { words, imgs } = useMemo(() => {
    const tokens = text.match(/\S+/g) ?? []
    const imgCount = (text.match(/\[img:[^\]]+\]/g) ?? []).length
    return { words: tokens.filter((w) => !w.startsWith("[img:")).length, imgs: imgCount }
  }, [text])

  const insertAt = (start: number, end: number, inserted: string) => {
    setText((t) => t.slice(0, start) + inserted + t.slice(end))
  }

  /** insertAt, minus anti-theft watermark sentences — with an undo toast when anything was dropped. */
  const insertCleaned = (ta: HTMLTextAreaElement, start: number, end: number, raw: string) => {
    const { text: cleaned, removed } = stripWatermarks(raw)
    if (!removed.length) return insertAt(start, end, raw)
    const base = ta.value
    setText(base.slice(0, start) + cleaned + base.slice(end))
    const first = removed[0].length > 90 ? `${removed[0].slice(0, 90)}…` : removed[0]
    toast.info(`Filtered ${removed.length} watermark${removed.length > 1 ? "s" : ""}`, {
      description: removed.length > 1 ? `${first} (+${removed.length - 1} more)` : first,
      duration: 10000,
      action: { label: "Undo", onClick: () => setText(base.slice(0, start) + raw + base.slice(end)) },
    })
  }

  /** Chapter copied from a web page: keep its illustrations as [img:…] lines. */
  const importHtml = async (html: string, ta: HTMLTextAreaElement) => {
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const { text: parsed, urls } = htmlChapter(html)
    if (!urls.length) {
      insertCleaned(ta, start, end, parsed)
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
      insertCleaned(ta, start, end, final)
      const failed = results.filter((r) => !r).length
      if (failed) toast.error(`${failed} of ${urls.length} image${urls.length > 1 ? "s" : ""} could not be imported`, { id: tid })
      else toast.success(`Imported ${urls.length} image${urls.length > 1 ? "s" : ""}`, { id: tid })
    } finally {
      setImporting((n) => n - 1)
    }
  }

  /** Image data on the clipboard (copy image / screenshot). */
  const importBlobs = async (blobs: Blob[], ta: HTMLTextAreaElement) => {
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
      return
    }
    // Plain text falls through to the default paste unless it carries
    // watermarks, so clean pastes keep the native undo stack.
    const plain = cd.getData("text/plain")
    if (plain && stripWatermarks(plain).removed.length) {
      e.preventDefault()
      const ta = e.currentTarget
      insertCleaned(ta, ta.selectionStart, ta.selectionEnd, plain)
    }
  }

  /** One-click import via the async clipboard API (same handling as Ctrl+V). */
  const pasteFromClipboard = async () => {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    try {
      const items = await navigator.clipboard.read()
      let html: string | null = null
      let plain = ""
      const blobs: Blob[] = []
      for (const it of items) {
        if (!html && it.types.includes("text/html")) html = await (await it.getType("text/html")).text()
        const imgType = it.types.find((t) => t.startsWith("image/"))
        if (imgType) blobs.push(await it.getType(imgType))
        if (it.types.includes("text/plain")) plain += await (await it.getType("text/plain")).text()
      }
      if (blobs.length) return void importBlobs(blobs, ta)
      if (html && /<img[\s>]/i.test(html)) return void importHtml(html, ta)
      if (plain) return insertCleaned(ta, ta.selectionStart, ta.selectionEnd, plain)
      toast.info("Clipboard is empty")
    } catch {
      try {
        const t = await navigator.clipboard.readText()
        if (t) insertCleaned(ta, ta.selectionStart, ta.selectionEnd, t)
        else toast.info("Clipboard is empty")
      } catch {
        toast.error("Clipboard unavailable — press Ctrl+V in the text area instead")
      }
    }
  }

  const submit = async () => {
    const t = text.trim()
    onOpenChange(false)
    if (!t) return
    if (!(await player.pasteText(t))) {
      toast.error("Failed to load chapter — is the server running?")
    }
  }

  const listenMin = Math.max(1, Math.round(words / WPM))
  const stats =
    words > 0
      ? `${words.toLocaleString()} words · ~${listenMin} min${imgs ? ` · ${imgs} image${imgs > 1 ? "s" : ""}` : ""}`
      : imgs
        ? `${imgs} image${imgs > 1 ? "s" : ""}`
        : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste chapter</DialogTitle>
          <DialogDescription>
            Replaces the current chapter — illustrations in the copied selection are kept, and anti-theft watermark
            lines are filtered out. Every chapter's position is remembered, so re-pasting an earlier one resumes where
            you left off.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            aria-label="Chapter text"
            className={cn("h-[50vh] resize-none font-sans text-[15px] leading-relaxed", text && "pr-10")}
            autoFocus
          />
          {!text && importing === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Button variant="outline" className="pointer-events-auto" onClick={() => void pasteFromClipboard()}>
                <ClipboardPaste data-icon="inline-start" aria-hidden />
                Paste from clipboard
              </Button>
              <span className="text-xs text-muted-foreground">or press Ctrl+V here</span>
            </div>
          )}
          {text && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2 text-muted-foreground"
              onClick={() => {
                setText("")
                taRef.current?.focus()
              }}
              title="Clear text"
              aria-label="Clear text"
            >
              <Eraser aria-hidden />
            </Button>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto self-center font-mono text-[11px] tabular-nums text-muted-foreground max-sm:hidden">
            {stats || "ctrl+↵ loads the chapter"}
          </span>
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
