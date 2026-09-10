import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import { player } from "@/lib/player"
import "./index.css"
import { Boot } from "@desktop/Boot"
import { installDesktopGlue } from "@desktop/desktop"

declare global {
  interface Window {
    __flushPosition?: () => void
  }
}

// The Rust side evals `window.__flushPosition?.()` on CloseRequested, before
// destroying the window — see install_close_flush in
// desktop/src-tauri/src/window.rs. flushPosition is an unbound class method,
// so it must be wrapped rather than assigned directly (that would lose
// `this`).
window.__flushPosition = () => player.flushPosition()

installDesktopGlue(() => {
  // App.tsx opens the paste dialog from its own state; the dock's Paste button
  // is the single entry point, so click it rather than duplicating that state.
  document.querySelector<HTMLButtonElement>("[data-paste-trigger]")?.click()
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot>
      <App />
    </Boot>
  </StrictMode>,
)
