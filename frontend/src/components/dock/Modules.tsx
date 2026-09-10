import { useEffect, useState } from "react"
import { Gauge, Loader2, Volume1, Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { EngineModeList, activeEngineIcon } from "@/components/EngineModePicker"
import { VoiceCombobox } from "@/components/VoiceCombobox"
import type { EngineInfo } from "@/lib/api"
import { player, usePlayer } from "@/lib/player"
import { Bracket, DockDivider, IconStack } from "./Bracket"
import { Clock } from "./Clock"

const SPEED_PRESETS = [1, 1.25, 1.5, 2]

function EngineModule({ engine, busy }: { engine: EngineInfo | null; busy: boolean }) {
  const active = engine?.active ?? "gpu"
  const ActiveIcon = activeEngineIcon(engine)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Voice engine (GPU / CPU)"
          aria-label="Voice engine"
          className="font-normal max-md:w-7 max-md:px-0"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin text-(--mod-engine)" aria-hidden />
          ) : (
            <ActiveIcon className="size-3.5 text-(--mod-engine)" aria-hidden />
          )}
          <span className="font-mono text-xs max-md:hidden">{active.toUpperCase()}</span>
          {engine != null && engine.speed > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground max-xl:hidden">
              {engine.speed.toFixed(1)}×
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
        <EngineModeList engine={engine} />
      </PopoverContent>
    </Popover>
  )
}

/** Second bracket on the left: who reads and on what. */
export function NarrationBracket() {
  const { voice, voices, engine, switchingTo } = usePlayer()
  const engineBusy = switchingTo !== null || !!engine?.loading

  return (
    <Bracket label="Narration" delay={0.13}>
      <VoiceCombobox voice={voice} voices={voices} dock />
      <DockDivider />
      <EngineModule engine={engine} busy={engineBusy} />
    </Bracket>
  )
}

function fmtTime(s: number): string {
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const min = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return h ? `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${min}:${String(sec).padStart(2, "0")}`
}

/** Elapsed / total chapter time from real chunk durations (ticking while
 *  playing) and the sentence counter. The time waits for the first known
 *  duration; the counter shows as soon as there is a chapter. */
function Readout({ playing, idx, n }: { playing: boolean; idx: number; n: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setTick((k) => k + 1), 1000)
    return () => clearInterval(t)
  }, [playing])

  const { elapsed, total, estimated } = player.times()
  return (
    <span className="flex h-7 items-center font-mono text-[11px] tabular-nums text-muted-foreground select-none max-xl:hidden">
      {total > 0 && (
        <>
          <span className="px-1.5" title={estimated ? "Total is estimated until every sentence has audio" : "Elapsed / total"}>
            {fmtTime(elapsed)} / {estimated ? "~" : ""}
            {fmtTime(total)}
          </span>
          <DockDivider />
        </>
      )}
      <span className="px-1.5" title={`Sentence ${idx + 1} of ${n}`}>
        {idx + 1}/{n}
      </span>
      <DockDivider />
    </span>
  )
}

function VolumeModule({ volume, muted }: { volume: number; muted: boolean }) {
  const effective = muted ? 0 : volume
  const state = effective === 0 ? "muted" : effective < 0.5 ? "low" : "high"
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative"
        onClick={() => player.toggleMute()}
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        <IconStack active={state} icons={{ muted: VolumeX, low: Volume1, high: Volume2 }} className="text-(--mod-volume)" />
      </Button>
      <Slider
        className="mr-1.5 ml-0.5 w-20 max-lg:hidden"
        value={[Math.round(effective * 100)]}
        min={0}
        max={100}
        step={1}
        onValueChange={([v]) => player.setVolume(v / 100)}
        onValueCommit={() => player.commitVolume()}
        aria-label="Volume"
      />
    </>
  )
}

function SpeedModule({ speed, pauseMs }: { speed: number; pauseMs: number }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono text-xs font-normal tabular-nums max-sm:w-7 max-sm:px-0"
          title="Playback speed"
          aria-label={`Playback speed, ${speed.toFixed(2)}×`}
        >
          <Gauge className="size-3.5 text-(--mod-speed)" aria-hidden />
          <span className="max-sm:hidden">{speed.toFixed(2)}×</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-60">
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
          <div className="flex items-center justify-between pt-1">
            <Label className="text-xs text-muted-foreground">Pause between sentences</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{(pauseMs / 1000).toFixed(2)}s</span>
          </div>
          <Slider
            value={[pauseMs]}
            min={0}
            max={2000}
            step={50}
            onValueChange={([v]) => player.setPause(v)}
            onValueCommit={() => player.commitPause()}
            aria-label="Pause between sentences"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Right bracket: the status modules — readout, volume, speed, clock. Each
 *  icon wears one colour from the scheme's own ramp (sketchybar's
 *  convention); the user's accent stays reserved for playback state. */
export function StatusBracket({ showClock }: { showClock: boolean }) {
  const { chunks, idx, playing, speed, volume, pauseMs, muted } = usePlayer()
  const n = chunks.length

  return (
    <Bracket label="Status" delay={0.19} className="justify-self-end">
      {n > 0 && <Readout playing={playing} idx={idx} n={n} />}
      <VolumeModule volume={volume} muted={muted} />
      <DockDivider />
      <SpeedModule speed={speed} pauseMs={pauseMs} />
      {showClock && (
        <>
          <DockDivider className="max-sm:hidden" />
          <Clock className="max-sm:hidden" />
        </>
      )}
    </Bracket>
  )
}
