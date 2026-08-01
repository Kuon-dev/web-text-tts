import { useEffect, useState } from "react"
import { getBackendState, onBackendState, restartBackend, type BackendState } from "@desktop/desktop"

const COPY: Record<BackendState["phase"], string> = {
  discovering: "Looking for a running server…",
  spawning: "Starting the TTS backend…",
  waiting: "Waiting for the backend to come up…",
  ready: "Ready",
  attached: "Attached to a server started elsewhere",
  failed: "The backend could not be started",
  exited: "The backend stopped",
}

export function Boot({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BackendState | null>(null)

  useEffect(() => {
    getBackendState().then((s) => s && setState(s))
    const un = onBackendState(setState)
    return () => {
      un.then((f) => f())
    }
  }, [])

  if (state && (state.phase === "ready" || state.phase === "attached")) {
    // Belt-and-braces for the Rust-side `window.eval` in health.rs's
    // `publish()`: Tauri can start navigating the window before `setup`
    // (and thus that eval) runs, so the injection can land on a
    // not-yet-committed document and be silently discarded — see Finding 2.
    // Setting it here, from state the frontend already receives over the
    // `backend://state` event, removes the race instead of narrowing it.
    ;(globalThis as { __API_BASE__?: string }).__API_BASE__ = state.base ?? ""
    return <>{children}</>
  }

  const failed = state?.phase === "failed" || state?.phase === "exited"
  const slow = (state?.elapsedS ?? 0) > 20

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
      <div className="w-full max-w-xl rounded-xl border bg-card p-6 shadow-sm">
        <p className="font-mono text-sm text-muted-foreground">novel-tts</p>
        <h1 className="mt-2 text-lg font-medium">{state ? COPY[state.phase] : COPY.discovering}</h1>

        {state?.message && <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>}

        {!failed && slow && (
          <p className="mt-2 text-sm text-muted-foreground">
            This can take several minutes on the first run — it downloads model weights.
            {state?.elapsedS ? ` (${state.elapsedS}s)` : ""}
          </p>
        )}

        {!!state?.logTail?.length && (
          <details className="mt-4" open={failed}>
            <summary className="cursor-pointer text-sm text-muted-foreground">Backend output</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {state.logTail.map((l, i) => (
                <div key={i} className={l.stream === "stderr" ? "text-destructive" : undefined}>
                  {l.text}
                </div>
              ))}
            </pre>
          </details>
        )}

        {failed && (
          <button
            type="button"
            onClick={() => restartBackend()}
            className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
