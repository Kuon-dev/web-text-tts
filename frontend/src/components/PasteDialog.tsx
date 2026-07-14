import { useEffect, useState } from "react"
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
import { player } from "@/lib/player"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PasteDialog({ open, onOpenChange }: Props) {
  const [text, setText] = useState("")

  useEffect(() => {
    if (open) setText("")
  }, [open])

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
            Replaces the current chapter. Each chapter's position is remembered — re-pasting an earlier one resumes
            where you left off.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Paste the chapter here…"
          className="h-[50vh] resize-none font-serif text-[15px] leading-relaxed"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!text.trim()}>
            Load &amp; play
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
