# Widgets

Floating panels over the reader — a clock, a pomodoro timer, later a
character-relations chart — each a self-contained folder registered in one
table. Panels drag, remember where they were, and never touch the reader
tree. `w` hides them for a look at the text.

This spec is the framework plus its first two widgets. The chart is a
follow-up spec; the contract here is shaped so it fits (see Non-goals).

## Decisions

- **Floating panels, not a side column, dock modules, or a drawer.** Chosen
  for flexibility; the design pays for it with constraints: drag only, no
  resize; a widget declares its own size; panels default into the gutters
  beside the reader column; the layer is hidden below `md` and over the
  settings view.
- **Descriptor registry, not a class hierarchy.** A widget is a plain
  `WidgetMeta` object plus a component. The registry is one frozen table,
  the way `ACTIONS` in `keymap.ts:81` is — settings switches, palette rows,
  and the layer are all *derived* from it, so adding a widget touches no
  framework logic.
- **Pure / UI split per widget.** `meta.ts` (id, size, store factory,
  actions) imports no React; `<Name>.tsx` is the face. `keymap.ts` and the
  node tests see only the metas. Same seam as `bookmarks.ts` vs `Reader.tsx`.
- **Repo store pattern, not zustand.** Widget stores are
  `subscribe` / `getSnapshot` objects consumed through `useSyncExternalStore`,
  as `player.ts` and `hud.ts` are, built on one `createExternalStore<T>()`
  helper so a store is a few lines. No new dependency; one store style.
- **Widgets reach the app through ports.** `WidgetHost` exposes `playback`,
  `storage`, `notify`, `ticker`, `now`. `lib/widgets/host.ts` is the only
  file that knows `player`, `sonner`, and `localStorage` exist. Tests hand
  widgets a fake host.
- **Hand-rolled drag.** `App.tsx:103` mounts `LazyMotion` with `domAnimation`
  and `strict`; motion's `drag` lives in `domMax`. A pointer-capture hook that
  writes `transform` directly is ~40 lines, costs no bundle, and does zero
  React work until the pointer lifts.
- **Layout is device-scoped, in localStorage.** Positions are screen
  geometry; the Tauri window shares nothing with the browser's window size.
  Validate-on-load like `reading.ts:144`.
- **A widget's live state exists exactly while it is enabled.** The runtime
  creates the store when the id enters the layout and disposes it when the
  id leaves. Closing the pomodoro panel ends the session; a page reload
  while it is enabled restores it.
- **Deadline-based timers.** The pomodoro stores `endsAt`, never a tick
  count. Chrome clamps timers to 1s in a hidden tab and to ~1/min after a
  while; a late tick still computes the right remaining time. One shared
  ticker per cadence, boundary-aligned as the dock clock already is,
  re-fired on `visibilitychange`.

## Files

```
src/lib/ticker.ts                     shared wall-clock scheduler; useNow(cadence)
src/lib/widgets/types.ts              WidgetMeta, WidgetDef, WidgetHost + ports, PanelGeom, LayoutState
src/lib/widgets/store.ts              createExternalStore<T>()
src/lib/widgets/manifest.ts           WIDGET_MANIFEST: readonly WidgetMeta[]   (pure)
src/lib/widgets/layout.ts             pure geometry + codec
src/lib/widgets/layout-store.ts       LayoutStore, localStorage, useWidgetLayout()
src/lib/widgets/runtime.ts            store lifecycle; runtime.get(id)
src/lib/widgets/host.ts               createHost(id)
src/lib/widgets/registry.ts           WIDGETS: manifest zipped with Icon + Component
src/lib/widgets/actions.ts            widgetActions(manifest) → Action[]  (pure)
src/components/widgets/WidgetLayer.tsx
src/components/widgets/PanelFrame.tsx
src/components/widgets/useDrag.ts
src/components/settings/WidgetsSection.tsx
src/widgets/clock/meta.ts, Clock.tsx
src/widgets/pomodoro/meta.ts, machine.ts, store.ts, Pomodoro.tsx
```

`lib/` holds pure logic and hooks, `components/` the chrome, `widgets/<id>/`
one folder per widget — the repo's existing split. `registry.ts` is the only
module that imports from `widgets/*/<Name>.tsx`; everything pure imports
`manifest.ts`.

## The contract — `lib/widgets/types.ts`

```ts
export interface Disposable { dispose(): void }

export interface WidgetAction<S> {
  id: string                 // "toggle"; composed as `${widget.id}-${id}` → "pomodoro-toggle"
  label: string
  keys: KeySpec[]            // [] = palette only
  run: (store: S) => void
}

export interface WidgetMeta<S = void> {
  id: string                 // stable; storage key, palette id, layout key
  title: string
  size: { w: number; h: number }   // rem — scales with uiScale like the dock
  side: "left" | "right"           // gutter a fresh panel lands in
  createStore?: (host: WidgetHost) => S & Disposable
  actions?: readonly WidgetAction<S>[]
}

export type WidgetDef<S = void> = WidgetMeta<S> & {
  Icon: LucideIcon
  Component: ComponentType<{ store: S }>   // lazy() accepted; frame wraps in Suspense
}

export interface PlaybackPort { isPlaying(): boolean; pause(): void; play(): void }
export interface StoragePort {                          // pre-scoped: "novel-tts:widget:<id>"
  read<T>(parse: (raw: unknown) => T | null): T | null   // null on absent, garbage, or throw
  write(value: unknown): void
  clear(): void
}
export interface NotifyPort {
  toast(message: string, opts?: { id?: string; action?: { label: string; onClick: () => void } }): void
}
export interface Ticker {
  every(cadence: "second" | "minute", fn: (now: number) => void): () => void
}
export interface WidgetHost {
  playback: PlaybackPort
  storage: StoragePort
  notify: NotifyPort
  ticker: Ticker
  now(): number
}
```

`createStore` is optional and so is `actions`: a widget with neither (the
clock) is complete, not stubbed. `S` defaults to `void`, so a stateless
widget's component takes `{ store: void }` and ignores it.

`host.ts` wires the ports: `playback` to `player` (which gains `pause()` and
`play()`, split out of `togglePlay()` at `player.ts:366`), `notify` to
sonner's `toast`, `storage` to `localStorage` under the widget's key with the
same try/catch the prefs use, `ticker` to `lib/ticker.ts`, `now` to
`Date.now`.

## The ticker — `lib/ticker.ts`

One timer per cadence, created when the first listener subscribes and
cleared when the last leaves. Fires on the boundary
(`60_000 - now % 60_000 + 50` for minutes — the scheduler `dock/Clock.tsx:6`
already has — and the same shape for seconds), passing `now` to every
listener. A `visibilitychange` to visible fires an immediate tick so a
throttled tab catches up; the listener is installed only when `document`
exists, guarded the way `isMac()` in `keymap.ts` is, so the module imports
under node. `useNow(cadence): number` wraps it for components.

`dock/Clock.tsx` replaces its private `useNow` with this one. No behaviour
change; one scheduler instead of two once the clock widget exists.

## Layout — `lib/widgets/layout.ts` and `layout-store.ts`

```ts
export interface PanelGeom { x: number; y: number }          // px, viewport coords
export interface LayoutState {
  order: readonly string[]                                   // enabled, in z-order; last = top
  geom: Readonly<Record<string, PanelGeom>>
  hidden: boolean
}
export interface LayoutEnv { vw: number; vh: number; readerW: number; dockH: number; rem: number }

enable(s, id, geom) · disable(s, id) · raise(s, id) · move(s, id, geom) · toggleHidden(s)
placeNew(meta, s, sizes: Record<string, {w; h}>, env): PanelGeom   // sizes in rem, from the manifest
clampAll(s, sizes: Record<string, {w; h}>, env): LayoutState
parseLayout(raw: unknown, knownIds: readonly string[]): LayoutState
```

`placeNew` puts a panel in its `side` gutter: `x` one `rem` outside the
reader column, whose width App knows as `min(vw, readerMaxWidth(prefs.width))`
(`reading.ts:138`), `y` one `rem` below the lowest panel already on that
side, starting one `rem` from the top. A gutter narrower than the panel still
gets the panel — it overlaps the column, and the user drags it. `clampAll`
takes `sizes` in rem (converted through `env.rem`) and keeps at least the
title bar (2.25rem) of every panel inside `[0, vw] × [0, vh − dockH]`.

Z-order is DOM order. `raise` moves the id to the end of `order`; React keys
keep panel instances across the reorder, so there is no z-index arithmetic.

`LayoutStore` (`createExternalStore` around `LayoutState`) persists to
`novel-tts:widgets` on every mutation except `move` during a drag — the
drag hook calls `move` once, on pointer-up. `parseLayout` on load: drops ids
not in the manifest; an id whose geometry is missing or non-finite is dropped
from `order` as well — that widget is off until enabled again, when
`placeNew` positions it; `hidden` defaults to `false`; garbage yields the
empty layout. A `resize` listener (throttled to animation frames) runs
`clampAll`.

The store owns the environment `placeNew` and `clampAll` need. `vw`, `vh`,
`rem` (root font-size, which `uiScale` changes) and `dockH` (the `--dock-h`
custom property `Dock.tsx` publishes) are read from `window` and the root's
computed style at call time; `readerW` is pushed in by App through
`layout.setReaderWidth(readerMaxWidth(prefs.width))` in an effect keyed on
`prefs.width`. `layout.ts` stays pure — only the store touches `window`.

Store methods: `toggle(id)` (enable via `placeNew`, or disable), `enable`,
`disable`, `raise`, `move`, `toggleHidden`, `reset`, `setReaderWidth`.
`useWidgetLayout()` → `LayoutState` via `useSyncExternalStore`.

## Runtime — `lib/widgets/runtime.ts`

```ts
class WidgetRuntime {
  follow(layout: LayoutStore): () => void   // subscribe; sync on every change
  get<S>(id: string): (S & Disposable) | undefined
}
```

`sync` diffs `order` against the live map: an id that appeared gets
`meta.createStore(createHost(id))` (nothing for a widget without one); an id
that vanished gets `dispose()` and is dropped. App calls `follow` in one
effect at mount. Keymap actions reach a store through `get`; a widget whose
store is absent (disabled) makes its action a no-op.

## The layer — `components/widgets/`

**`WidgetLayer`** renders, for each id in `order`, a `PanelFrame` around
the def's `Component` with `store={runtime.get(id)}`. Root: `fixed inset-0 z-10 pointer-events-none
max-md:hidden`, plus `hidden` when `layout.hidden`; each panel restores
`pointer-events-auto`. Mounted by App only while `view.view === "reader"`.
Hidden panels keep their stores — hiding is CSS, and the pomodoro keeps
counting.

**`PanelFrame`** — two nested elements by necessity. The outer `div` is
`fixed left-0 top-0` with `width`/`height` in rem from `meta.size` and owns
`transform: translate(x, y)` — the drag hook's property. That transform is
applied imperatively in a `useLayoutEffect` keyed on the stored geometry,
never through the `style` prop: a re-render of the panel's content mid-drag
(a pomodoro tick) must not hand React a stale `translate` to write back
under the pointer. The inner `m.div`
owns the enter/exit `opacity` + `scale` spring under `AnimatePresence`, the
conflict `AdjustHUD.tsx` documents and resolves the same way. Frosted card
like the dock and HUD (`rounded-lg border bg-card/85 backdrop-blur
shadow-lg`). `role="region"`, `aria-label={title}`. A title bar — icon +
title, the drag handle, `cursor-grab` — and a close button that calls
`layout.disable(id)`. `pointerdown` anywhere on the frame calls `raise`.
Content sits in `Suspense` with the empty card as fallback. `z-10` places the
layer above the reader tile and below the dock, HUD (`z-20`) and Radix
overlays (`z-50`).

Nothing in the frame is focusable except its buttons, so the keymap's
`controlFocused` guard (`keymap.ts:239`) already does the right thing: Space
on a focused widget button activates it, not playback — as with dock buttons.

**`useDrag(ref, id)`** — `pointerdown` on the handle: `setPointerCapture`,
record the grab offset; `pointermove`: write `el.style.transform` directly;
`pointerup`/`pointercancel`: `releasePointerCapture`, `layout.move(id, geom)`
once. No React render happens during the drag; `transform` is
compositor-only. Ignores non-primary buttons and starts only from the
handle, so a click on a widget's own control never begins a drag.

## Actions — `lib/widgets/actions.ts`, `lib/keymap.ts`

`ACTIONS` becomes `[...APP_ACTIONS, ...widgetActions(WIDGET_MANIFEST)]` —
still one frozen array, still the single source the palette
(`CommandPalette.tsx:33`) and the sheet derive from. `Group` gains
`"Widgets"`.

| id | key | label | scope |
|---|---|---|---|
| `widgets-hide` | `w` | Show / hide widgets | reader |
| `widget-clock` | — | Toggle clock | reader |
| `widget-pomodoro` | — | Toggle pomodoro | reader |
| `pomodoro-toggle` | `t` | Start / pause pomodoro | reader |

The first is fixed; the toggles are one per manifest entry, running
`layout.toggle(id)` (enable with `placeNew`, or disable); the last comes from
`pomodoro`'s `meta.actions`, wrapped as
`run: () => { const s = runtime.get(id); if (s) a.run(s) }`. `t` and `w` are
unclaimed — taken are `k , p ? space ← → ↑ ↓ m [ ] v e b n ⇧B ⇧N`, and `z`
stays pinned unbound. All `reader`-scoped like `voice` / `model`, so none
fire in text entry, over an overlay, or on the settings page — where the
layer is not shown anyway.

`keys: []` is new: `matchAction` never matches it, the palette lists it, and
the shortcuts sheet skips rows without keys.

## Settings — `WidgetsSection.tsx`

`Section` in `view.ts:3` gains `"widgets"` (so `#settings/widgets` parses for
free); `SECTION_META` in `SettingsPage.tsx:33` gains
`{ label: "Widgets", Icon: LayoutGrid }`. The section is a `SectionHeader`
whose reset calls `layout.reset()` (empty layout — every widget off, positions
forgotten) and one `SwitchRow` per manifest entry, checked when the id is in
`order`, toggling through `layout.toggle(id)`. No preview pane, as with
Voice. `showClock` in Appearance is untouched: the dock clock is a module,
not a widget. `SECTION_DEFAULTS` in `settings.ts` does not grow — the layout
is not a `ReadingPrefs` key.

## The widgets

### Clock — `widgets/clock/`

`meta.ts`: `{ id: "clock", title: "Clock", size: { w: 12, h: 5 }, side: "right" }`.
`Clock.tsx`: the time large, mono, tabular; weekday and date beneath;
both locale-formatted exactly as `dock/Clock.tsx` does; `useNow("minute")`.
Subscribes to nothing else, so the 2s status poll never renders it.

### Pomodoro — `widgets/pomodoro/`

`machine.ts` — pure; every function takes `now`:

```ts
export type Phase = "work" | "short" | "long"
export interface Config { workMin: number; shortMin: number; longMin: number; roundsPerLong: number; pauseOnBreak: boolean }
export const DEFAULT_CONFIG: Config = { workMin: 25, shortMin: 5, longMin: 15, roundsPerLong: 4, pauseOnBreak: true }
export type State =
  | { status: "idle";    phase: Phase; round: number }
  | { status: "running"; phase: Phase; round: number; endsAt: number }
  | { status: "paused";  phase: Phase; round: number; remainingMs: number }
start(s, cfg, now) · pause(s, now) · resume(s, now) · skip(s, cfg, now): { state: State; entered: Phase } · reset()   // skip is a transition too: same toast / pause rules
remaining(s, cfg, now): number                             // ms, never negative; a full phase when idle
advance(s, cfg, now): { state: State; entered: Phase | null }
nextPhase(phase, round, cfg): { phase: Phase; round: number }
parseSession(raw, now): { config: Config; state: State } | null
```

`round` counts completed work phases in the current cycle; the
`roundsPerLong`-th work phase is followed by `long` and resets the count.
`skip` ends the phase without counting a partial work round. Durations are
clamped 1–120 minutes, rounds 2–8. `parseSession` restores a saved session:
paused → paused; running with a future `endsAt` → running; running with a
passed `endsAt` → **paused at the start of the next phase** — one step, not a
replay of every phase missed since — the user was not there for the bell, so
no toast and no playback change on restore.

`store.ts` — `createStore(host)` returns `createExternalStore` around
`{ config, state, tick }` with `start`, `pause`, `resume`, `toggle`, `skip`,
`reset`, `setConfig`, `dispose`. Rules:

- Subscribes to `host.ticker.every("second")` only while `running`; the
  subscription is dropped on pause, idle, and dispose. Each tick bumps `tick`
  (so the face re-renders) and calls `advance`.
- On `entered === "short" | "long"`: `host.playback.pause()` if
  `config.pauseOnBreak`, and a toast — `Short break — 5:00` /
  `Long break — 15:00` (the configured minutes) — with the stable id
  `"pomodoro"`, so successive phases replace rather than stack.
- On `entered === "work"`: `Back to work — 25:00` under the same id, with an
  action **Resume reading** → `host.playback.play()`. The voice never
  auto-resumes.
- Persists `{ config, state }` through `host.storage` on every transition,
  pause, reset, and `setConfig` — not per tick; `endsAt` is absolute.
- Constructor calls `parseSession(host.storage.read(...), host.now())`; a
  restored `running` session subscribes to the ticker immediately.
- `dispose()` drops the subscription and calls `host.storage.clear()`.

`Pomodoro.tsx` (`size: { w: 14, h: 9 }`, `side: "right"`): remaining time
(`mm:ss`, tabular mono, derived from `remaining(state, Date.now())` on each
render), phase label, `roundsPerLong` round dots, start/pause · skip · reset
buttons, and a gear `Popover` holding three `NumberField`s (work / short /
long, minutes) plus a `SwitchRow` for pause-on-break, all writing through
`setConfig`. Idle shows `workMin:00`.

## Integration

- `lib/ticker.ts` (new); `dock/Clock.tsx` uses it.
- `lib/widgets/*` (new), `components/widgets/*` (new), `widgets/*` (new),
  `components/settings/WidgetsSection.tsx` (new).
- `lib/player.ts`: `pause()`, `play()`.
- `lib/keymap.ts`: `APP_ACTIONS` + spread; `Group` gains `"Widgets"`;
  `Action.keys` may be empty.
- `components/ShortcutsDialog.tsx`: skip keyless rows.
- `lib/view.ts`, `components/settings/SettingsPage.tsx`: the section.
- `App.tsx`: mount `<WidgetLayer />` in the reader branch; one effect for
  `runtime.follow(layout)`; one effect pushing `readerMaxWidth(prefs.width)`
  into `layout.setReaderWidth`.
- `npm run build -w frontend` emits into `../static`; its own `build: ship …`
  commit, as the repo does.

## Testing

Vitest, node environment, pure modules only (`vitest.config.ts`):

- `lib/widgets/layout.test.ts` — enable/disable/raise/move; `placeNew` stacks
  below the lowest panel on its side and still places into a gutter narrower
  than the panel; `clampAll` keeps every title bar reachable after a shrink;
  `parseLayout` drops unknown ids and non-finite geometry, returns the empty
  layout on garbage, and round-trips a serialized state.
- `lib/ticker.test.ts` (fake timers) — fires on the boundary; N listeners
  share one timer; the last unsubscribe clears it.
- `widgets/pomodoro/machine.test.ts` — work → short → work … → long over
  `roundsPerLong` rounds; `skip` does not count a partial round; pause keeps
  `remainingMs`; resume re-derives `endsAt`; `advance` across a passed
  deadline; `remaining` never negative; `parseSession` lands a stale running
  session paused at the next phase; clamps out-of-range config.
- `widgets/pomodoro/store.test.ts` with a fake host — pauses playback on a
  break, not on work, and not when `pauseOnBreak` is off; the work toast
  carries a Resume action that calls `play`; writes storage only on
  transitions; holds no ticker subscription while paused; `dispose` clears
  storage and the subscription; a restored running session ticks.
- `lib/widgets/actions.test.ts` — one toggle per manifest entry; a widget
  action on a disabled widget is a no-op.
- `lib/keymap.test.ts` — `t` and `w` bound, `Widgets` group present, `z`
  still unbound; the paired-actions pin is unchanged.

## Non-goals

- **Resize.** Widgets declare their size. A resize handle is additive to
  `PanelFrame` and `PanelGeom` later.
- **Snapping, several instances of one widget, arrow-key nudging.**
- **A chime.** In this app the voice stopping is the bell; the toast covers
  the visible case.
- **Widgets below `md`, or over the settings view.**
- **Dock faces for widgets.** The dock clock stays a dock module.
- **The character-relations chart.** Its own spec. This contract already
  gives it a `lazy()` component and a device-scoped `StoragePort`; it will
  need a *document*-scoped port backed by `state.json` (the bookmarks
  precedent — shared with the Tauri shell) and likely an MCP tool so the
  translating agent can supply characters and relations. Both are new
  members on `WidgetHost`, not changes to anything here.
