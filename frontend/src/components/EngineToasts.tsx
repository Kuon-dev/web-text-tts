import { useEffect } from "react"
import { toast } from "sonner"
import { ENGINE_TOAST, useEngineLabel } from "@/components/EngineModePicker"
import { player, usePlayer } from "@/lib/player"

const GPU_TOAST = "gpu-busy"

// A finished switch is followed by the model load only once the next status
// poll (2 s) reports it; the loading toast waits that long before it goes,
// so the two waits read as one toast updated in place rather than a blink.
const SWITCH_GRACE_MS = 2600

/** Engine progress as toasts, so the dock never changes height: one toast
 *  (id ENGINE_TOAST) follows a switch from "switching" through "loading" to
 *  "ready", and a warning stays up for as long as the GPU is busy. Renders
 *  nothing. */
export function EngineToasts() {
  const { engine, switchingTo, blocked } = usePlayer()
  const switchingLabel = useEngineLabel(switchingTo)
  const loading = !!engine?.loading
  const label = engine?.label ?? ""

  useEffect(() => {
    if (switchingTo !== null) {
      toast.loading(`Switching to ${switchingLabel}…`, { id: ENGINE_TOAST, duration: Infinity })
      return
    }
    if (loading) {
      toast.loading(`Loading ${label}…`, { id: ENGINE_TOAST, duration: Infinity })
      return
    }
    // Idle. Take down a loading toast that nothing replaced (a switch whose
    // weights were already resident, or one that failed — the error toast
    // took its place, and is left alone here); a success or error toast
    // times out on its own.
    const t = window.setTimeout(() => {
      if (toast.getToasts().some((x) => x.id === ENGINE_TOAST && "type" in x && x.type === "loading")) toast.dismiss(ENGINE_TOAST)
    }, SWITCH_GRACE_MS)
    return () => window.clearTimeout(t)
  }, [switchingTo, switchingLabel, loading, label])

  // A model load runs tens of seconds (minutes on a first download) and
  // usually ends long after the user has closed settings and gone back to
  // reading, so the end of the wait is announced, in the same toast.
  useEffect(() => player.onEngineReady((ready) => toast.success(`${ready} ready`, { id: ENGINE_TOAST, duration: 4000 })), [])

  useEffect(() => {
    if (blocked) {
      toast.warning("Paused — GPU busy", {
        id: GPU_TOAST,
        description: "Qwen3 has no CPU mode. Playback resumes when the GPU frees up.",
        duration: Infinity,
      })
    } else {
      toast.dismiss(GPU_TOAST)
    }
  }, [blocked])

  return null
}
