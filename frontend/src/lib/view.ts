import { useCallback, useEffect, useState } from "react"

export type Section = "appearance" | "reading" | "wallpaper" | "voice"
export const SECTIONS: readonly Section[] = ["appearance", "reading", "wallpaper", "voice"]

export type ViewState = { view: "reader" } | { view: "settings"; section: Section }

const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s)

/** `#settings` or `#settings/<section>` opens the page; anything else is the reader. */
export function parseHash(hash: string): ViewState {
  const [head, tail = ""] = hash.replace(/^#/, "").split("/")
  if (head !== "settings") return { view: "reader" }
  return { view: "settings", section: isSection(tail) ? tail : "appearance" }
}

export function hashFor(state: ViewState): string {
  return state.view === "settings" ? `#settings/${state.section}` : ""
}

// Remembered for the session so reopening lands on the last section visited.
let lastSection: Section = "appearance"

/**
 * Reader / settings switch backed by the URL hash. Opening pushes one history
 * entry (so the browser back button closes the page); switching sections
 * replaces it (so back still returns to the reader in one step); closing pops
 * that entry when it is ours, or just clears the hash when the page was
 * loaded on `#settings` directly.
 */
export function useView() {
  const [state, setState] = useState<ViewState>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onPop = () => setState(parseHash(window.location.hash))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const openSettings = useCallback((section: Section = lastSection) => {
    lastSection = section
    const next: ViewState = { view: "settings", section }
    window.history.pushState({ settings: true }, "", hashFor(next))
    setState(next)
  }, [])

  const setSection = useCallback((section: Section) => {
    lastSection = section
    const next: ViewState = { view: "settings", section }
    // Keep whatever state the entry already had: stamping `{settings: true}`
    // here would make closeSettings believe it pushed an entry it did not,
    // and `history.back()` from a directly-loaded #settings URL leaves the app.
    window.history.replaceState(window.history.state, "", hashFor(next))
    setState(next)
  }, [])

  const closeSettings = useCallback(() => {
    if ((window.history.state as { settings?: boolean } | null)?.settings) {
      window.history.back() // popstate flips the view
      return
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search)
    setState({ view: "reader" })
  }, [])

  return { state, openSettings, setSection, closeSettings }
}
