import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The desktop app compiles the SAME React tree as the web app: `@` points at
// ../frontend/src and publicDir at ../frontend/public. Only main.tsx and the
// Tauri glue are local to this workspace.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../frontend/src"),
      "@desktop": path.resolve(__dirname, "./src"),
    },
  },
  publicDir: path.resolve(__dirname, "../frontend/public"),
  // NEVER "../static": frontend/vite.config.ts builds there with
  // emptyOutDir, and would delete the web app's bundle.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // index.css uses oklch()/color-mix() and watermark.ts uses a regex
    // lookbehind, so safari13 (the Tauri template default) is far too low.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari16",
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    // Dev-only convenience so the app works in a plain browser before the
    // Rust shell injects a base URL.
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
})
