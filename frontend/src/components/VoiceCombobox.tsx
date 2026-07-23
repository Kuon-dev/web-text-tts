import { useMemo, useState } from "react"
import { ChevronsUpDown, MicVocal, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { deleteClone, voiceLabel, type Voice } from "@/lib/api"
import { player } from "@/lib/player"
import { cn } from "@/lib/utils"

function confirmDelete(v: Voice) {
  toast(`Delete cloned voice "${v.name}"?`, {
    action: {
      label: "Delete",
      onClick: () => {
        void (async () => {
          try {
            await deleteClone(v.id)
            await player.refreshVoices()
            toast.success(`"${v.name}" deleted`)
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Delete failed")
          }
        })()
      },
    },
    cancel: { label: "Cancel", onClick: () => {} },
  })
}

export function VoiceCombobox({ voice, voices, className }: { voice: string; voices: Voice[]; className?: string }) {
  const [open, setOpen] = useState(false)

  const groups = useMemo(() => {
    const m = new Map<string, Voice[]>()
    voices.forEach((v) => {
      m.set(v.group, [...(m.get(v.group) ?? []), v])
    })
    return [...m.entries()]
  }, [voices])

  const selected = voices.find((v) => v.id === voice)

  const select = async (v: string) => {
    setOpen(false)
    if (v !== voice && !(await player.setVoice(v))) {
      toast.error("Voice change failed — is the server running?")
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Narrator voice"
          title="Narrator voice"
          className={cn("w-48 justify-between font-normal", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <MicVocal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{selected ? voiceLabel(selected) : voice || "Voice"}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Search voices…" />
          <CommandList>
            <CommandEmpty>No voice found.</CommandEmpty>
            {groups.map(([group, vs]) => (
              <CommandGroup key={group} heading={group}>
                {vs.map((v) => (
                  <CommandItem
                    key={v.id}
                    value={`${voiceLabel(v)} ${v.id}`}
                    data-checked={v.id === voice}
                    onSelect={() => void select(v.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    {v.group === "Cloned" && (
                      <button
                        type="button"
                        aria-label={`Delete ${v.name}`}
                        title={`Delete ${v.name}`}
                        className="ml-auto shrink-0 rounded-sm p-0.5 opacity-0 hover:text-destructive group-hover/command-item:opacity-100"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          confirmDelete(v)
                        }}
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
