import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { openUrl } from "@tauri-apps/plugin-opener"
import { player } from "@/lib/player"

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

/** Menu commands the Rust side forwards, plus the external-link interception
 *  that `<a target="_blank">` needs — it is inert inside a webview. */
export function installDesktopGlue(onPaste: () => void) {
  void listen("menu://play-pause", () => player.togglePlay())
  void listen("menu://prev", () => player.jump(player.getSnapshot().idx - 1))
  void listen("menu://next", () => player.jump(player.getSnapshot().idx + 1))
  void listen("menu://paste", onPaste)
  void listen("menu://restart-backend", () => restartBackend())

  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[target='_blank']") as
        | HTMLAnchorElement
        | null
      if (!a?.href) return
      e.preventDefault()
      void openUrl(a.href)
    },
    true,
  )
}
