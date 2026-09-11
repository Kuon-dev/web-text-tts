import { player } from "./player"

export type Scope = "global" | "reader"
export type Group = "Playback" | "Audio" | "Narration" | "Bookmarks" | "App"

export interface KeySpec {
  /** Compared to `e.key`, not `e.code`: "k" | "," | "ArrowUp" | " " | "?" | "[". */
  key: string
  /** ⌘ on mac, Ctrl elsewhere; matched as (metaKey || ctrlKey). */
  mod?: true
  shift?: true
}

/** The App-level callbacks an action can reach. Everything else an action needs
 *  (playback, audio, narration) lives in the player singleton, which is a module
 *  global — only the dialogs App owns have to be injected. */
export interface KeymapCtx {
  openPalette: () => void
  openPalettePage: (page: "voice" | "model" | "bookmarks") => void
  openHelp: () => void
  openPaste: () => void
  toggleSettings: () => void
}

export interface Action {
  id: string
  /** "Play / pause" — shown by both the palette and the shortcuts sheet. */
  label: string
  group: Group
  scope: Scope
  /** `keys[0]` is the headline binding shown in the UI; the rest are aliases. */
  keys: KeySpec[]
  /** May fire on auto-repeat. Toggles may not: leaning on the space bar would
   *  otherwise machine-gun play/pause. */
  repeatable?: true
  /** Omit from the palette's root list (default: included). */
  palette?: false
  /** The other half of a two-key pair (←/→, ⇧↑/⇧↓, [/]) and the label the two
   *  share, set on the first of the pair only. The sheet renders them as one
   *  row, because that is how the keys are learned — nobody memorises "next
   *  sentence" without "previous". The palette keeps them apart: there a row
   *  is a thing you run, and running "previous / next" means nothing. */
  pair?: { with: string; label: string }
  run: (ctx: KeymapCtx) => void
}

/** Deliberately not a `KeyboardEvent`: the dispatcher hands matchAction a plain
 *  object, so the whole matching table is testable under `vitest`'s node
 *  environment, where no DOM event constructor exists. */
export type KeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">

export interface KeymapGuards {
  /** Focus is in an `input`, `textarea`, or `[contenteditable="true"]`. */
  textEntry: boolean
  /** Focus is on a control that owns the key itself (`button`, `select`, a
   *  slider, listbox, menu, or dialog). */
  controlFocused: boolean
  overlayOpen: boolean
}

const LETTER = /^[a-z]$/

/**
 * The bindings, in one table, because the palette and the shortcuts sheet are
 * generated from it — documentation that is derived cannot drift from the keys
 * it documents.
 *
 * Every ⌘ combo carries an unmodified twin. Chrome on macOS keeps ⌘, for its
 * own Settings and never delivers it to the page, so a mod-only binding would
 * be silently dead in exactly the browser most of these users are in; the bare
 * twin is the one that actually fires there.
 *
 * The `reader` scope is what preserves today's behaviour of the keys App.tsx
 * used to handle inline: space activates a focused dock button rather than
 * toggling playback. `global` actions are reachable from anywhere, including
 * the settings page.
 *
 * Escape is absent on purpose — Radix and SettingsPage.tsx already handle it,
 * and a row here would double-handle it. The sheet documents it statically.
 */
export const ACTIONS: readonly Action[] = [
  {
    id: "palette",
    label: "Command palette",
    group: "App",
    scope: "global",
    keys: [{ key: "k", mod: true }, { key: "k" }],
    // The one action with nothing to offer the palette's own root list: the
    // palette is already open by the time you could read the row.
    palette: false,
    run: (ctx) => ctx.openPalette(),
  },
  {
    id: "settings",
    label: "Settings",
    group: "App",
    scope: "global",
    keys: [{ key: ",", mod: true }, { key: "," }],
    run: (ctx) => ctx.toggleSettings(),
  },
  {
    id: "paste",
    label: "Paste chapter",
    group: "App",
    scope: "global",
    keys: [{ key: "p", mod: true }, { key: "p" }],
    run: (ctx) => ctx.openPaste(),
  },
  {
    id: "help",
    label: "Keyboard shortcuts",
    group: "App",
    scope: "global",
    keys: [{ key: "?" }],
    run: (ctx) => ctx.openHelp(),
  },
  {
    id: "play-pause",
    label: "Play / pause",
    group: "Playback",
    scope: "reader",
    keys: [{ key: " " }],
    run: () => player.togglePlay(),
  },
  {
    id: "prev-sentence",
    label: "Previous sentence",
    group: "Playback",
    scope: "reader",
    keys: [{ key: "ArrowLeft" }],
    pair: { with: "next-sentence", label: "Previous / next sentence" },
    run: () => player.jump(player.getSnapshot().idx - 1),
  },
  {
    id: "next-sentence",
    label: "Next sentence",
    group: "Playback",
    scope: "reader",
    keys: [{ key: "ArrowRight" }],
    run: () => player.jump(player.getSnapshot().idx + 1),
  },
  {
    // Shift, not bare arrows: ↑/↓ scroll the chapter panel and have to keep
    // doing so.
    id: "volume-up",
    label: "Volume up",
    group: "Audio",
    scope: "reader",
    keys: [{ key: "ArrowUp", shift: true }],
    repeatable: true,
    pair: { with: "volume-down", label: "Volume up / down" },
    run: () => player.nudgeVolume(1),
  },
  {
    id: "volume-down",
    label: "Volume down",
    group: "Audio",
    scope: "reader",
    keys: [{ key: "ArrowDown", shift: true }],
    repeatable: true,
    run: () => player.nudgeVolume(-1),
  },
  {
    id: "mute",
    label: "Mute",
    group: "Audio",
    scope: "reader",
    keys: [{ key: "m" }],
    run: () => player.toggleMute(),
  },
  {
    id: "speed-down",
    label: "Speed down",
    group: "Audio",
    scope: "reader",
    keys: [{ key: "[" }],
    repeatable: true,
    pair: { with: "speed-up", label: "Speed down / up" },
    run: () => player.nudgeSpeed(-1),
  },
  {
    id: "speed-up",
    label: "Speed up",
    group: "Audio",
    scope: "reader",
    keys: [{ key: "]" }],
    repeatable: true,
    run: () => player.nudgeSpeed(1),
  },
  {
    id: "voice",
    label: "Voice…",
    group: "Narration",
    scope: "reader",
    keys: [{ key: "v" }],
    run: (ctx) => ctx.openPalettePage("voice"),
  },
  {
    id: "model",
    label: "Model…",
    group: "Narration",
    scope: "reader",
    keys: [{ key: "e" }],
    run: (ctx) => ctx.openPalettePage("model"),
  },
  {
    // A bookmark marks the sentence the voice is on, not the one nearest the
    // middle of the viewport: `b` is pressed because of something just heard.
    id: "bookmark-toggle",
    label: "Toggle bookmark",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "b" }],
    run: () => player.toggleBookmark(),
  },
  {
    // Declared before its sibling: `pair` is set on the first half only, or
    // the sheet renders the row twice and swallows the wrong partner.
    id: "bookmark-prev",
    label: "Previous bookmark",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "N", shift: true }],
    pair: { with: "bookmark-next", label: "Previous / next bookmark" },
    run: () => player.prevBookmark(),
  },
  {
    id: "bookmark-next",
    label: "Next bookmark",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "n" }],
    run: () => player.nextBookmark(),
  },
  {
    // "reader", matching `voice` and `model` — the other actions that open a
    // palette page — so it does not fire while the settings page is up.
    id: "bookmark-list",
    label: "Bookmarks…",
    group: "Bookmarks",
    scope: "reader",
    keys: [{ key: "B", shift: true }],
    run: (ctx) => ctx.openPalettePage("bookmarks"),
  },
]

/** One spec against one event. The rules are ordered as the design spec states
 *  them; each exists to stop a specific misfire. */
function matchesSpec(e: KeyEventLike, spec: KeySpec): boolean {
  // 1. `mod` is metaKey OR ctrlKey, always both, so this hot path — it runs on
  //    every keystroke in the app — never has to ask what machine it is on.
  //    Only formatSpec is platform-aware, and only for display.
  const mod = e.metaKey || e.ctrlKey
  // 2. A spec without `mod` demands meta, ctrl AND alt all be off. Without the
  //    meta/ctrl half, the bare `,` twin would fire on ⌘, as well, running the
  //    action twice on the platforms that do deliver the combo. Without the alt
  //    half, Option+key — which types real characters on a Mac, ⌥p is π — would
  //    trigger actions while someone is composing text.
  if (spec.mod ? !mod : mod || e.altKey) return false
  // 3. Shift is only consulted when the spec asks for it. `?` is inherently
  //    shifted on most layouts and must match on its `e.key` alone, or it would
  //    need a shift flag that layouts producing an unshifted `?` then break.
  //    Letters are the exception in the other direction: they compare
  //    case-insensitively so Caps Lock still mutes, but require shift off so
  //    ⇧M cannot fire mute while typing a capital in the reader.
  if (spec.shift) return e.shiftKey && e.key === spec.key
  if (LETTER.test(spec.key)) return !e.shiftKey && e.key.toLowerCase() === spec.key
  return e.key === spec.key
}

/**
 * The action a key event should run, or null. Guards are two orthogonal
 * predicates rather than one condition because they block different sets:
 * text entry only has to stop the *unmodified* keys from typing themselves
 * into the box (⌘K must keep working there), while a focused control or an
 * open overlay only has to stand the *reader* actions down.
 */
export function matchAction(e: KeyEventLike, opts: KeymapGuards): Action | null {
  for (const action of ACTIONS) {
    for (const spec of action.keys) {
      if (!matchesSpec(e, spec)) continue
      // 4. Auto-repeat is a ramp, not a re-press: holding ⇧↑ should keep
      //    raising the volume, but a held space bar must not toggle play over
      //    and over.
      if (e.repeat && !action.repeatable) return null
      // `p` and `,` would otherwise type themselves into the paste box.
      if (opts.textEntry && !spec.mod) return null
      // The focused control owns the key: space activates a dock button, an
      // open dialog owns its own arrows. The settings page is deliberately not
      // an overlay, so space keeps pausing the voice while you change fonts.
      if (action.scope === "reader" && (opts.controlFocused || opts.overlayOpen)) return null
      return action
    }
  }
  return null
}

const KEY_LABELS: Record<string, string> = {
  " ": "space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
}

/** "⌘K" / "Ctrl K", "⇧↑", "space", "[". The only platform branch in the module:
 *  ⌘ is a glyph and reads fine glued to the key, "Ctrl" is a word and needs the
 *  space. ⇧ stays a glyph on both platforms — it is unambiguous, and spelling it
 *  out would double the width of the two arrow rows in the sheet. */
export function formatSpec(spec: KeySpec, mac: boolean): string {
  // A letter is uppercased only under a modifier, where "⌘K" is the universal
  // spelling. The bare twin stays lowercase: "K" next to "⌘K" reads as if it
  // wanted Shift, which is exactly the key it must not ask for.
  let out = KEY_LABELS[spec.key] ?? (LETTER.test(spec.key) && spec.mod ? spec.key.toUpperCase() : spec.key)
  if (spec.shift) out = `⇧${out}`
  if (spec.mod) out = mac ? `⌘${out}` : `Ctrl ${out}`
  return out
}

/** Guarded so the module stays importable under `vitest`'s node environment,
 *  where this is the only line that would touch the DOM. `navigator.platform`
 *  is deprecated and can be empty, so fall through to the user agent. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}
