import { useMemo, useState } from "react"
import { ChevronsUpDown, MicVocal } from "lucide-react"
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
import { voiceGroup, voiceLabel, voiceName } from "@/lib/api"
import { player } from "@/lib/player"
import { cn } from "@/lib/utils"

export function VoiceCombobox({ voice, voices, className }: { voice: string; voices: string[]; className?: string }) {
  const [open, setOpen] = useState(false)

  const groups = useMemo(() => {
    const m = new Map<string, string[]>()
    voices.forEach((v) => {
      const g = voiceGroup(v)
      m.set(g, [...(m.get(g) ?? []), v])
    })
    return [...m.entries()]
  }, [voices])

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
            <span className="truncate">{voice ? voiceLabel(voice) : "Voice"}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Search voices…" />
          <CommandList>
            <CommandEmpty>No voice found.</CommandEmpty>
            {groups.map(([group, ids]) => (
              <CommandGroup key={group} heading={group}>
                {ids.map((v) => (
                  <CommandItem key={v} value={`${voiceLabel(v)} ${v}`} data-checked={v === voice} onSelect={() => void select(v)}>
                    {voiceName(v)}
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
