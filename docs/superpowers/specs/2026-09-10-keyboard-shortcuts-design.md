# Keyboard shortcuts, command palette, and help sheet

A keyboard layer for the reader: one registry that binds the keys, fills the
command palette, and generates the shortcuts sheet — so the documentation
cannot drift from the bindings.

Replaces the ad-hoc `keydown` block in `App.tsx` (Space / ←/→ with one
hardcoded `closest(...)` guard).

## Decisions

- **Hybrid input model.** Discrete choices (voice, model) get searchable
  palette pages; continuous values (volume, speed) get direct keys with a
  transient HUD. The palette also lists the continuous actions, for discovery.
- **Cmd combos each get an unmodified twin.** Chrome on macOS keeps `⌘,` for
  its own Settings and never delivers it to the page; the bare `,` twin means
  nothing in the keymap is silently dead in a browser tab.
- **`Shift+↑/↓` for volume**, leaving bare arrows to scroll the reader.
- **Read-only sheet, no remapping.** One registry is the single source of
  truth for binding, palette, and sheet.
- **Central registry + one dispatcher.** Not per-component registration:
  `App.tsx` unmounts `Reader` while settings is open, so distributed bindings
  would vanish depending on the mounted view.

## The registry — `src/lib/keymap.ts`

Pure data and pure functions. No React, no DOM (`vitest` runs in `node`).

```ts
export type Scope = "global" | "reader"
export type Group = "Playback" | "Audio" | "Narration" | "App"

export interface KeySpec {
  key: string   // "k" | "," | "ArrowUp" | " " | "?" | "[" — compared to e.key
  mod?: true    // ⌘ on mac, Ctrl elsewhere; matched as (metaKey || ctrlKey)
  shift?: true
}

export interface KeymapCtx {
  openPalette: () => void
  openPalettePage: (page: "voice" | "model") => void
  openHelp: () => void
  openPaste: () => void
  toggleSettings: () => void
}

export interface Action {
  id: string
  label: string        // "Play / pause" — shown by both palette and sheet
  group: Group
  scope: Scope
  keys: KeySpec[]      // [0] is the headline binding; the rest are aliases
  repeatable?: true    // may fire on auto-repeat; toggles may not
  palette?: false      // omit from the palette root list (default: included)
  run: (ctx: KeymapCtx) => void
}

export const ACTIONS: readonly Action[]
```

### Matching rules

`matchAction(e: KeyEventLike, opts: { textEntry: boolean; controlFocused: boolean; overlayOpen: boolean }): Action | null`

where `KeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">`.

1. **`mod` matches `metaKey || ctrlKey`.** Both, so there is no platform branch
   in the hot path; only *display* is platform-aware.
2. **A spec without `mod` requires `meta`, `ctrl` and `alt` all false.** This is
   what stops the bare `,` twin from also firing on `⌘,`, and stops Option+key
   (which types real characters on a Mac) from triggering anything.
3. **`shift` is checked only when the spec sets it.** `Shift+↑` is explicit;
   `?` is inherently shifted and matches on `e.key === "?"` alone; letter keys
   compare case-insensitively but require shift *off*, so `M` never fires mute.
4. **`e.repeat` fires only for `repeatable` actions** — holding `Shift+↑` ramps
   the volume; leaning on the space bar does not machine-gun play/pause.

### Guards (two orthogonal predicates, not one condition)

- `textEntry` (focus in `input`, `textarea`, `[contenteditable="true"]`) blocks
  every **modifier-less** spec — otherwise `p` and `,` would type themselves
  into the paste box. `⌘K` still works there.
- `scope: "reader"` additionally stands down when `controlFocused` (`button`,
  `select`, `[role="slider"]`, `[role="listbox"]`, `[role="menu"]`,
  `[role="dialog"]`) or `overlayOpen`. This preserves today's behaviour: space
  activates a focused dock button rather than toggling playback.

### Display

`formatSpec(spec: KeySpec, mac: boolean): string` — `"⌘K"` / `"Ctrl K"`,
`"⇧↑"`, `"space"`, `"["`. `isMac()` reads `navigator.platform`/`userAgent`
behind a guard so the module stays importable in `node` tests.

### The table

| Group | Keys | Action | Scope |
|---|---|---|---|
| App | `⌘K` · `k` | Command palette | global |
| App | `⌘,` · `,` | Settings (toggles) | global |
| App | `⌘P` · `p` | Paste chapter | global |
| App | `?` | Keyboard shortcuts | global |
| Playback | `space` | Play / pause | reader |
| Playback | `←` `→` | Previous / next sentence | reader |
| Audio | `⇧↑` `⇧↓` | Volume ±5% (repeatable) | reader |
| Audio | `m` | Mute | reader |
| Audio | `[` `]` | Speed ∓0.05× (repeatable) | reader |
| Narration | `v` | Voice… (palette page) | reader |
| Narration | `e` | Model… (palette page) | reader |

Escape stays with Radix and `SettingsPage.tsx`'s existing handler — putting it
in the table would double-handle it. The sheet documents it as a static row.

## The dispatcher — `useKeymap(ctx)` in `App.tsx`

One `document` `keydown` listener replacing `App.tsx:63-84`. It derives
`textEntry` / `controlFocused` from `e.target.closest(...)`, passes
`overlayOpen`, and calls `action.run(ctx)` plus `e.preventDefault()` on a hit.

`ctx` is memoised so the listener is installed once. App owns `paletteOpen`,
`helpOpen`, `pasteOpen`; `overlayOpen` is their union.

**The settings page is deliberately not an overlay** — space keeps pausing the
voice while you change fonts.

## Player nudges — `src/lib/player.ts`

```ts
nudgeVolume(direction: 1 | -1): void   // step 0.05, clamp 0..1
nudgeSpeed(direction: 1 | -1): void    // step 0.05, clamp 0.75..2
```

Both reuse `stepValue()` from `lib/settings.ts` (already tested: snaps to the
step grid, clamps, and keeps float noise out), apply the change locally through
the existing `setVolume`/`setSpeed`, push the value to the HUD, and **debounce
the `/api/state` commit by 400 ms** so holding a key does not spam the server.
Ranges match the existing dock sliders (`dock/Modules.tsx`).

Nudging volume up while muted unmutes, which `setVolume` already does.

## The HUD — `src/lib/hud.ts` + `src/components/AdjustHUD.tsx`

A `useSyncExternalStore` store in the same shape as `player.ts`:

```ts
hud.show(kind: "volume" | "speed", value: number): void
useHud(): { kind: "volume" | "speed"; value: number; seq: number } | null
```

Auto-clears 1200 ms after the last `show`. `seq` increments per call so a
re-nudge at the same value still restarts the timer and re-triggers animation.

`AdjustHUD` renders a frosted pill centred above the dock at
`bottom: calc(var(--dock-h) + 0.75rem)`, showing the icon, a bar, and the
value (`72%` / `1.25×`). `aria-hidden` — the actions are announced by the
controls they change; motion respects the existing `MotionConfig
reducedMotion="user"`.

## The palette — `src/components/CommandPalette.tsx`

`cmdk` (already a dependency, already wrapped in `ui/command.tsx` and used by
`VoiceCombobox`) in a `CommandDialog`.

- **Root page**: every action with `palette !== false`, grouped by `Group`,
  each row showing its headline key via `formatSpec`.
- **Pages**: `voice` and `model`. Page state is a `useState<Page | null>`;
  Backspace on an empty input pops a page, Escape pops one level then closes.
- The voice page reuses the grouping logic from `VoiceCombobox` (extract the
  `useMemo` grouping into a shared helper; the delete affordance stays in the
  combobox only). The model page reuses `useEngineCatalog` from
  `EngineModePicker.tsx` — **export it**, it is currently module-private.

## The help sheet — `src/components/ShortcutsDialog.tsx`

Radix `Dialog`, grouped from `ACTIONS`, keys rendered with `formatSpec` in
`<kbd>`, plus the static Escape row. Opened by `?` and by a palette row.

## Integration

- Delete the handler at `App.tsx:63-84`.
- `⌘P` calls the same `openPaste` state setter the dock button uses, so the
  desktop glue (`desktop/src/main.tsx:25` clicks `[data-paste-trigger]`) is
  untouched.
- Update the shortcuts line in `README.md:11` to point at `?`.
- No new dock button: the palette root and `?` are the discovery paths.

## Testing

`vitest` runs in `node` and only picks up `src/**/*.test.ts` — logic lives in
`lib/` and is tested there; components carry no tests (no jsdom, no
testing-library in this project).

- `keymap.test.ts` — every matching rule above, both guard predicates, the
  repeat rule, alias resolution, and `formatSpec` on both platforms.
- `hud.test.ts` — show/expiry/`seq`, with fake timers.
- `player.test.ts` (extend) — nudge clamping at both ends, step-grid snapping,
  unmute-on-raise, and that the commit is debounced to one call.
