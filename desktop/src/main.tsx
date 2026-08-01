import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import "./index.css"
import { Boot } from "@desktop/Boot"
import { installDesktopGlue } from "@desktop/desktop"

installDesktopGlue(() => {
  // App.tsx opens the paste dialog from its own state; the top-bar button is
  // the single entry point, so click it rather than duplicating that state.
  document.querySelector<HTMLButtonElement>("[data-paste-trigger]")?.click()
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot>
      <App />
    </Boot>
  </StrictMode>,
)
