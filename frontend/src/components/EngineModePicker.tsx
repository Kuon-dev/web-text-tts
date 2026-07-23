import { useEffect, useState } from "react"
import { AudioLines, Cpu, Gpu, Sparkles } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import { getEngines, type DeviceMode, type EngineEntry, type EngineInfo } from "@/lib/api"
import { player } from "@/lib/player"
import { cn } from "@/lib/utils"

export const ENGINE_OPTIONS: { key: DeviceMode; label: string; Icon: LucideIcon; desc: string }[] = [
  { key: "auto", label: "Auto", Icon: Sparkles, desc: "GPU when it's free, CPU when a game needs it" },
  { key: "gpu", label: "GPU", Icon: Gpu, desc: "Always the GPU — fastest, but competes with games" },
  { key: "cpu", label: "CPU", Icon: Cpu, desc: "Never touches the GPU — smoothest for gaming" },
]

const ALL_MODES: DeviceMode[] = ["auto", "gpu", "cpu"]

export function activeEngineIcon(engine: EngineInfo | null): LucideIcon {
  return (engine?.active ?? "gpu") === "gpu" ? Gpu : Cpu
}

// The engine catalog barely ever changes within a running server, so the
// popover / settings dialog share one fetch instead of hitting /api/engines
// on every open.
let enginesPromise: Promise<{ engines: EngineEntry[]; current: string }> | null = null
function fetchEngines() {
  if (!enginesPromise) {
    enginesPromise = getEngines().catch((err: unknown) => {
      enginesPromise = null
      throw err
    })
  }
  return enginesPromise
}

function useEngineCatalog(): EngineEntry[] {
  const [engines, setEngines] = useState<EngineEntry[]>([])
  useEffect(() => {
    fetchEngines()
      .then((r) => setEngines(r.engines))
      .catch(() => {})
  }, [])
  return engines
}

/** TTS engine cards (Kokoro / Qwen3, ...) — unavailable engines show their reason. */
export function EngineList({
  engines,
  current,
  engineInfo,
}: {
  engines: EngineEntry[]
  current: string
  engineInfo: EngineInfo | null
}) {
  const select = async (id: string) => {
    if (id === current) return
    try {
      await player.setEngine(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Engine switch failed — is the server running?")
    }
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">Engine</Label>
      {engines.map((e) => (
        <button
          key={e.id}
          type="button"
          disabled={!e.available}
          onClick={() => void select(e.id)}
          aria-pressed={current === e.id}
          className={cn(
            "flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            current === e.id && "bg-secondary",
          )}
        >
          <AudioLines className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {e.label}
              {current === e.id && engineInfo?.cold ? " · loading model…" : ""}
            </span>
            <span className="block text-xs text-muted-foreground">
              {e.available ? (e.id === "qwen3" ? "Japanese, cloning, style — GPU only" : "Fast, 16 voices, CPU fallback") : e.reason}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** Engine cards, header row (active device + speed), and the three device-mode
 *  buttons — shared by the player-bar popover and the settings dialog. */
export function EngineModeList({ engine }: { engine: EngineInfo | null }) {
  const engines = useEngineCatalog()
  const current = engine?.engine ?? ""
  const supported = engines.find((e) => e.id === current)?.supported_modes ?? ALL_MODES
  const mode = engine?.mode ?? "auto"
  const active = engine?.active ?? "gpu"

  const select = async (m: DeviceMode) => {
    if (m === mode) return
    try {
      await player.setDeviceMode(m)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Engine change failed — is the server running?")
    }
  }

  return (
    <div className="space-y-3">
      {engines.length > 0 && <EngineList engines={engines} current={current} engineInfo={engine} />}
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Device</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {active.toUpperCase()}
          {engine && engine.speed > 0 ? ` · ${engine.speed.toFixed(1)}× realtime` : ""}
        </span>
      </div>
      <div className="space-y-1">
        {ENGINE_OPTIONS.map(({ key, label, Icon, desc }) => (
          <button
            key={key}
            type="button"
            disabled={(key !== "cpu" && engine !== null && !engine.gpu_available) || !supported.includes(key)}
            onClick={() => void select(key)}
            aria-pressed={mode === key}
            className={cn(
              "flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
              mode === key && "bg-secondary",
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
