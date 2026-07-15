import { Cpu, Gpu, Sparkles } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import type { EngineInfo, EngineMode } from "@/lib/api"
import { player } from "@/lib/player"
import { cn } from "@/lib/utils"

export const ENGINE_OPTIONS: { key: EngineMode; label: string; Icon: LucideIcon; desc: string }[] = [
  { key: "auto", label: "Auto", Icon: Sparkles, desc: "GPU when it's free, CPU when a game needs it" },
  { key: "gpu", label: "GPU", Icon: Gpu, desc: "Always the GPU — fastest, but competes with games" },
  { key: "cpu", label: "CPU", Icon: Cpu, desc: "Never touches the GPU — smoothest for gaming" },
]

export function activeEngineIcon(engine: EngineInfo | null): LucideIcon {
  return (engine?.active ?? "gpu") === "gpu" ? Gpu : Cpu
}

/** Header row (active device + speed) and the three mode buttons — shared by
 *  the player-bar popover and the settings dialog. */
export function EngineModeList({ engine }: { engine: EngineInfo | null }) {
  const mode = engine?.mode ?? "auto"
  const active = engine?.active ?? "gpu"

  const select = async (m: EngineMode) => {
    if (m !== mode && !(await player.setEngineMode(m))) {
      toast.error("Engine change failed — is the server running?")
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Voice engine</Label>
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
            disabled={key !== "cpu" && engine !== null && !engine.gpu_available}
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
