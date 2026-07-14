import { useMemo, useState } from "react"
import type { MouseEvent } from "react"
import { ChevronsUpDown, MicVocal, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react"
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
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { voiceGroup, voiceLabel, voiceName } from "@/lib/api"
import { player, usePlayer } from "@/lib/player"

const SPEED_PRESETS = [1, 1.25, 1.5, 2]

function VoiceCombobox({ voice, voices }: { voice: string; voices: string[] }) {
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
          className="w-48 justify-between font-normal max-sm:w-28"
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

export function PlayerBar() {
  const { chunks, idx, playing, speed, volume, muted, voice, voices } = usePlayer()
  const n = chunks.length
  const pct = n ? ((idx + 1) / n) * 100 : 0
  const effectiveVolume = muted ? 0 : volume
  const VolumeIcon = effectiveVolume === 0 ? VolumeX : effectiveVolume < 0.5 ? Volume1 : Volume2

  const scrub = (e: MouseEvent<HTMLDivElement>) => {
    if (!n) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - r.left) / r.width
    player.jump(Math.round(ratio * (n - 1)))
  }

  return (
    <footer className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/90 backdrop-blur animate-in fade-in slide-in-from-bottom-4 duration-500 motion-reduce:animate-none">
      <div
        className="group/progress relative h-1 w-full cursor-pointer bg-secondary transition-[height] hover:h-1.5"
        onClick={scrub}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={n}
        aria-valuenow={n ? idx + 1 : 0}
        aria-label="Chapter progress"
        title="Click to jump"
      >
        <div
          className="h-full bg-(--progress-fill) transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 shadow-sm transition-[left,opacity] duration-300 ease-out group-hover/progress:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2.5">
        <div className="flex items-center">
          <VoiceCombobox voice={voice} voices={voices} />
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={!n}
            onClick={() => player.jump(idx - 1)}
            title="Previous sentence (←)"
            aria-label="Previous sentence"
          >
            <SkipBack aria-hidden />
          </Button>
          <Button
            size="icon-lg"
            disabled={!n}
            onClick={() => player.togglePlay()}
            title="Play / pause (Space)"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="animate-in fade-in zoom-in-75 duration-200" aria-hidden />
            ) : (
              <Play className="animate-in fade-in zoom-in-75 duration-200" aria-hidden />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!n}
            onClick={() => player.jump(idx + 1)}
            title="Next sentence (→)"
            aria-label="Next sentence"
          >
            <SkipForward aria-hidden />
          </Button>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => player.toggleMute()}
            title={muted ? "Unmute" : "Mute"}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            <VolumeIcon className="animate-in fade-in zoom-in-75 duration-200" aria-hidden />
          </Button>
          <Slider
            className="w-24 max-sm:hidden"
            value={[Math.round(effectiveVolume * 100)]}
            min={0}
            max={100}
            step={1}
            onValueChange={([v]) => player.setVolume(v / 100)}
            onValueCommit={() => player.commitVolume()}
            aria-label="Volume"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="w-16 tabular-nums" title="Playback speed">
                {speed.toFixed(2)}×
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Speed</Label>
                  <span className="text-xs tabular-nums text-muted-foreground">{speed.toFixed(2)}×</span>
                </div>
                <Slider
                  value={[speed]}
                  min={0.75}
                  max={2}
                  step={0.05}
                  onValueChange={([v]) => player.setSpeed(v)}
                  onValueCommit={() => player.commitSpeed()}
                  aria-label="Playback speed"
                />
                <div className="flex gap-1">
                  {SPEED_PRESETS.map((p) => (
                    <Button
                      key={p}
                      variant={speed === p ? "secondary" : "ghost"}
                      size="xs"
                      className="flex-1 tabular-nums"
                      onClick={() => {
                        player.setSpeed(p)
                        player.commitSpeed()
                      }}
                    >
                      {p}×
                    </Button>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <span className="w-16 text-right text-xs tabular-nums text-muted-foreground max-sm:hidden">
            {n ? `${idx + 1} / ${n}` : "— / —"}
          </span>
        </div>
      </div>
    </footer>
  )
}
