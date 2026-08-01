// Apply the saved theme before first paint (kept in sync with src/lib/theme.ts).
// Loaded as a CLASSIC script by both index.html files — a module script is
// deferred and would flash the wrong theme.
;(function () {
  var t = {}
  try { t = JSON.parse(localStorage.getItem("novel-tts:theme")) || {} } catch (e) {}
  var mode = t.mode === "light" || t.mode === "system" ? t.mode : "dark"
  var dark = mode === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : mode === "dark"
  var root = document.documentElement
  root.classList.toggle("dark", dark)
  var accents = ["indigo", "emerald", "rose", "amber", "sky"]
  root.dataset.accent = accents.indexOf(t.accent) >= 0 ? t.accent : "indigo"
  var schemes = ["zinc", "catppuccin", "dracula", "everforest", "gruvbox", "nord", "rosepine", "solarized", "tokyonight"]
  root.dataset.scheme = schemes.indexOf(t.scheme) >= 0 ? t.scheme : "zinc"
})()
