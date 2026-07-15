import { useEffect, useState } from "react"
import type { MouseEvent } from "react"
import { Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { m } from "motion/react"
import type { Transition } from "motion/react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { EngineModeList, activeEngineIcon } from "@/components/EngineModePicker"
import { VoiceCombobox } from "@/components/VoiceCombobox"
import type { EngineInfo } from "@/lib/api"
import { player, usePlayer } from "@/lib/player"

const SPEED_PRESETS = [1, 1.25, 1.5, 2]

const ICON_SPRING: Transition = { type: "spring", stiffness: 480, damping: 32 }

/** Cross-fades between stacked icons inside a fixed-size (relative) button —
 *  unlike a keyed remount, the outgoing icon animates away too. */
function IconStack<K extends string>({ active, icons }: { active: K; icons: Record<K, LucideIcon> }) {
  return (
    <>
      {(Object.entries(icons) as [K, LucideIcon][]).map(([key, Icon]) => (
        <m.span
          key={key}
          className="absolute inset-0 grid place-items-center"
          initial={false}
          animate={active === key ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
          transition={ICON_SPRING}
        >
          <Icon aria-hidden />
        </m.span>
      ))}
    </>
  )
}

function EngineMenu({ engine }: { engine: EngineInfo | null }) {
  const active = engine?.active ?? "gpu"
  const ActiveIcon = activeEngineIcon(engine)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Voice engine (GPU / CPU)"
          aria-label="Voice engine"
          className="font-normal"
        >
          <ActiveIcon className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="text-xs max-sm:hidden">{active.toUpperCase()}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <EngineModeList engine={engine} />
      </PopoverContent>
    </Popover>
  )
}

function fmtTime(s: number): string {
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const min = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return h ? `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${min}:${String(sec).padStart(2, "0")}`
}

/** Elapsed / total chapter time from real chunk durations, ticking while playing. */
function TimeDisplay({ playing, hasChunks }: { playing: boolean; hasChunks: boolean }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [playing])

  if (!hasChunks) return null
  const { elapsed, total, estimated } = player.times()
  if (total <= 0) return null
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {fmtTime(elapsed)} / {estimated ? "~" : ""}
      {fmtTime(total)}
    </span>
  )
}

export function PlayerBar() {
  const { chunks, idx, playing, speed, volume, muted, voice, voices, engine } = usePlayer()
  const n = chunks.length
  const pct = n ? ((idx + 1) / n) * 100 : 0
  const effectiveVolume = muted ? 0 : volume
  const volState = effectiveVolume === 0 ? "muted" : effectiveVolume < 0.5 ? "low" : "high"

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
        <m.div
          className="relative h-full bg-(--progress-fill)"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 200, damping: 30 }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-0 size-2.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground opacity-0 shadow-sm transition-opacity duration-300 group-hover/progress:opacity-100"
          />
        </m.div>
      </div>
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <VoiceCombobox voice={voice} voices={voices} className="max-sm:w-28" />
          <EngineMenu engine={engine} />
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
            className="relative"
            disabled={!n}
            onClick={() => player.togglePlay()}
            title="Play / pause (Space)"
            aria-label={playing ? "Pause" : "Play"}
          >
            <IconStack active={playing ? "pause" : "play"} icons={{ play: Play, pause: Pause }} />
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
            className="relative"
            onClick={() => player.toggleMute()}
            title={muted ? "Unmute" : "Mute"}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            <IconStack active={volState} icons={{ muted: VolumeX, low: Volume1, high: Volume2 }} />
          </Button>
          <Slider
            className="w-24 max-lg:hidden"
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
          <span className="flex flex-col items-end leading-tight max-sm:hidden">
            <TimeDisplay playing={playing} hasChunks={n > 0} />
            <span className="text-[10px] tabular-nums text-muted-foreground/70">{n ? `${idx + 1} / ${n}` : "— / —"}</span>
          </span>
        </div>
      </div>
    </footer>
  )
}
