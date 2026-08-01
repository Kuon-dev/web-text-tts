import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import "./index.css"
import { Boot } from "@desktop/Boot"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot>
      <App />
    </Boot>
  </StrictMode>,
)
