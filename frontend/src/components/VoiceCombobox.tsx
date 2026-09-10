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

/** `activeVoice` is the combobox's current selection at delete time: if the
 *  deleted clone was in use, the server already reset the voice to the
 *  engine's default and rechunked, so the client must refetch the doc the
 *  same way setVoice does after a rechunk — otherwise the trigger keeps
 *  showing the now-dangling deleted id. */
function confirmDelete(v: Voice, activeVoice: string) {
  toast(`Delete cloned voice "${v.name}"?`, {
    action: {
      label: "Delete",
      onClick: () => {
        void (async () => {
          try {
            await deleteClone(v.id)
            if (v.id === activeVoice) await player.reconcileDoc()
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

/** Voices bucketed by their engine-assigned `group`, in first-seen order — the
 *  server already sorts the list, so a Map keyed by group preserves that order
 *  without a second sort. Shared with the command palette's voice page, which
 *  shows the same voices under the same headings; only the delete affordance
 *  below is the combobox's own, because a palette row that can destroy a clone
 *  on a stray click is not a trade the discovery surface should make. */
export function useVoiceGroups(voices: Voice[]): [string, Voice[]][] {
  return useMemo(() => {
    const m = new Map<string, Voice[]>()
    voices.forEach((v) => {
      m.set(v.group, [...(m.get(v.group) ?? []), v])
    })
    return [...m.entries()]
  }, [voices])
}

/** `dock` renders the trigger as a dock module (ghost, tinted icon, name
 *  hidden on phones, popover opening upward); the default is the outline
 *  combobox the settings page uses. */
export function VoiceCombobox({
  voice,
  voices,
  className,
  dock = false,
}: {
  voice: string
  voices: Voice[]
  className?: string
  dock?: boolean
}) {
  const [open, setOpen] = useState(false)
  const groups = useVoiceGroups(voices)

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
          variant={dock ? "ghost" : "outline"}
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Narrator voice"
          title="Narrator voice"
          className={cn(dock ? "max-w-36 font-normal max-md:w-7 max-md:px-0" : "w-48 justify-between font-normal", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <MicVocal className={cn("size-3.5 shrink-0", dock ? "text-(--mod-voice)" : "text-muted-foreground")} aria-hidden />
            {/* The dock shows the narrator's name alone; the language lives in the list. */}
            <span className={cn("truncate", dock && "max-md:hidden")}>{selected ? (dock ? selected.name : voiceLabel(selected)) : "Voice"}</span>
          </span>
          <ChevronsUpDown className={cn("size-3.5 shrink-0 opacity-50", dock && "max-md:hidden")} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent side={dock ? "top" : undefined} align="start" className="w-56 p-0">
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
                          confirmDelete(v, voice)
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
