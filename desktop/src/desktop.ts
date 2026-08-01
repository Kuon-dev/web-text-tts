import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface LogLine {
  stream: string
  text: string
}

export interface BackendState {
  phase: "discovering" | "spawning" | "waiting" | "ready" | "attached" | "failed" | "exited"
  base: string | null
  elapsedS: number
  message: string | null
  logTail: LogLine[]
  owned: boolean
}

export const onBackendState = (fn: (s: BackendState) => void) =>
  listen<BackendState>("backend://state", (e) => fn(e.payload))

export const getBackendState = () => invoke<BackendState | null>("get_backend_state")
export const restartBackend = () => invoke<void>("restart_backend")
