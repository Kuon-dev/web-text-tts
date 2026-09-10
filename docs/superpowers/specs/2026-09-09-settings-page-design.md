# Settings page — design

Date: 2026-09-09. Replaces the two-column Settings dialog (v2.11 addendum in
`2026-07-14-novel-tts-design.md`) with a full settings view that has a live
preview.

## Problem

The Settings dialog is a modal over a blurred overlay. Every preference in it
applies live, but the overlay hides exactly the things being adjusted: the
wallpaper, the palette, and the reading text. Picking a font means reading
eighteen names in a dropdown; changing size means dragging a small slider and
closing the dialog to see the result. The dialog also scrolls internally at
88vh, so the lower sections are reached by scrolling a box inside a box.

## Goals

- Settings is a page-level view, not a modal, with the wallpaper live behind it
  and playback continuing.
- Every visual preference previews live *inside* the page, next to its control.
- Direct manipulation instead of dropdowns for choices with under ten options
  (palette, wallpaper fit) and a rich list for the font.
- Single-step precision for numeric prefs (stepper + slider), no fiddly drags.
- Minimal, calm, consistent with the existing "riced tiling-WM" look: card
  tiles, low radius, mono captions, muted labels.
- No new dependencies. No router. No change to how prefs are stored.

## Non-goals

- Playback settings (speed, sentence pause, volume) stay in the player bar
  popover. A Playback section could be added later.
- No server changes. No change to `ReadingPrefs`, `ThemePrefs`, or storage keys.
- No component-test harness; UI is verified through the build and the browser.

## Navigation and shell

### View state

A new `frontend/src/lib/view.ts` owns the reader/settings switch:

- `type Section = "appearance" | "reading" | "wallpaper" | "voice"`.
- `parseHash(hash)` → `{ view: "reader" } | { view: "settings"; section }`.
  `#settings` and `#settings/<section>` open settings; an unknown section
  falls back to `appearance`; anything else is the reader.
- `hashFor(view, section)` is the inverse (`""` for the reader).
- `useView()` hook: state initialised from `location.hash`; listens to
  `popstate` so the browser back button closes the page.
  - `openSettings(section?)` → `history.pushState({ settings: true }, "", hash)`.
  - `setSection(s)` → `history.replaceState(...)`, so back still returns to the
    reader in one step.
  - `closeSettings()` → `history.back()` when `history.state?.settings` is set
    (the entry is ours), else `replaceState` to the bare URL. Either way the
    view flips to the reader.

### App

`App.tsx` renders `<SettingsPage>` in place of `<Reader>` when the view is
`settings`. The wallpaper layer, the dock, PasteDialog and Toaster stay
mounted. Because the reader unmounts:

- On open, App records `window.scrollY`. On close it restores it in a
  `useLayoutEffect`, which runs before the reader's `useFollowChunk` passive
  effect; the follow hook then sees the sentence already on the reading line
  and does not glide, or glides only the distance playback advanced.
- Escape closes settings. The listener ignores events with `defaultPrevented`
  set, which is how Radix marks an Escape it used to close a popover, select
  or dialog. The existing Space / arrow handler keeps working on the page.

### Settings toggle

*(2026-09-10: the top bar is gone; its items live in the dock,
`frontend/src/components/dock/`.)* The dock's Settings item toggles the view;
while open it renders as the active space (`bg-secondary`, accent icon) with
`aria-pressed`, and takes focus back when the page closes and focus would
otherwise land on the body.

### Page layout

The page is a tile like the reader: `rounded-lg border bg-card/85
backdrop-blur-sm shadow-sm`, `max-w-[1180px]`, centred, with the reader's side
and top gaps (`px-2 pt-2 sm:px-3 sm:pt-3`). It enters with the reader's spring
(`opacity 0→1, scale 0.985→1, y 10→0`, stiffness 180, damping 24). No exit
animation; the reader animates in on its own when it returns.

*(2026-09-10)* The tile is a **fixed-height window**, the System Settings
model: one window that is the same size for every section, and only its
content scrolls. `main` is `h-dvh` with a bottom padding of `var(--dock-h)`
plus the gap, so the tile fills the space between the top gap and the dock
exactly; the tile is `flex flex-col overflow-hidden`, its header is fixed and
the body grid is `min-h-0 flex-1`. `--dock-h` is published on `<html>` by
`Dock.tsx` from a `ResizeObserver` on the footer (bar plus the gap under it;
a status line makes it taller and the window shrinks to match), with a
first-paint fallback in `index.css`. The document itself never scrolls while
settings is open.

Header row (border-b): title **Settings** with a muted one-line subtitle on
the left; on the right a mono `esc` hint and a **Done** button
(`variant="outline" size="sm"`).

Body, by width:

| Width | Layout |
|---|---|
| ≥ 1280px (`xl`) | Three columns: rail 176px · controls pane `minmax(0,1fr)` (content capped at 560px) · preview `minmax(300px,380px)`. Rail and preview are fixed columns; only the pane scrolls (`overflow-y-auto`, thin scrollbar, `scrollbar-gutter: stable` so the content width does not change between sections). |
| 768–1279px (`md`) | Rail · pane. The preview sits at the top of the pane, `sticky top-0` within it, capped at 560px like the controls. |
| < 768px | Rail becomes a horizontal, scrollable tab row above the pane. Preview on top of the controls, sticky within the pane, compact (see Preview). |

Rail items: icon + label, `text-muted-foreground`, hover `bg-accent`; the
active item is `bg-secondary text-foreground` and its icon takes
`text-(--accent-base)`. Icons: Palette (Appearance), Type (Reading), Image
(Wallpaper), MicVocal (Voice). Rail is a `nav` with `aria-label="Settings
sections"`; items are buttons with `aria-current="page"` when active.

Section switch: the controls column is keyed by section and fades in
(`opacity 0→1, y 4→0`, 150ms ease-out). Switching also scrolls the pane back
to its top if it is scrolled (`behavior: "smooth"`, or `"auto"` under reduced
motion). The last section visited is remembered for
the session (module-level variable) and is the default the next time the
page opens without a section in the hash.

## Preview pane

The pane is section-aware. It is presentational only: it reads the same
`prefs`/`theme`/`wallpaper` the controls write to.

### Reading → `ReadingPreview`

A card shaped like the reader tile (`rounded-lg border bg-card/85 p-5`)
rendering two short original paragraphs at 1:1 with the current
`fontFamily`, `fontSize`, `lineHeight`, `textAlign` (justify) and paragraph
`marginBottom` in em. The text includes an `<em>` phrase and a quoted line so
italics and quotes show in each face. One sentence in the second paragraph
carries the `hl-current` class so the accent highlight appears in context.

Sample text (original, fixed):

> The rain had stopped by the time she reached the station, though the
> platform still shone under the lamps. She counted the carriages as they
> slid past — seven, eight — and only then let herself breathe.
>
> "You're late," said the man in the grey coat, not unkindly. *So are you*,
> she thought, and said nothing.

The quoted sentence ("You're late," …) is the highlighted one, so the
italic phrase stays unhighlighted and readable.

Caption under the card, mono 11px muted: `Georgia · 18 px · 1.75 · ≈ 800 px
column`. The column figure uses `readerMaxWidth(width)` = `(width + 6) * 16`,
extracted from `Reader.tsx` into `reading.ts` so both use one formula.

Hover preview: while the pointer is over a font row (or a row has keyboard
focus), the card renders that font instead of the saved one and the caption
reads `Lora — click to use`. Leaving the list reverts. Only the font
hover-previews; other controls are cheap enough to commit on change.

Wherever the preview rides on top of the controls it is capped with a
bottom fade mask so the sticky copy can never outgrow the viewport and
cover the controls: `max-h-40` below `md`, `max-h-64` from `md`. Only at
`xl`, where the preview has its own column, is it uncapped. The caption
always remains.

### Appearance and Wallpaper → `AppMiniature`

A 16:10 frame (`w-full`, rounded, border) that draws the app in miniature
with CSS variables only, so it follows scheme, mode and accent live:

- Background `var(--background)`; if a wallpaper is set, an absolutely
  positioned layer with the same `backgroundImage`, position, opacity and
  fit rules as `App.tsx`. For `tile` and `center` (actual size), which are
  absolute, the miniature scales `background-size` to `img.w × ratio` by
  `img.h × ratio`, where `ratio = frameWidth / window.innerWidth`, so the
  miniature stays proportional. Frame width comes from a `ResizeObserver`.
- A top-bar strip with an accent dot; a reader tile (~70% wide, ~5 text
  lines as rounded `bg-foreground/15` bars, one line styled with
  `var(--hl-bg)` and `var(--hl-ring)` as the current sentence) with the
  focused-window border and glow (`--focus-border`, `--focus-glow`); a
  player-bar strip with a `--progress-fill` bar at 40%.
- No text inside the frame.

Caption: Appearance → `Zinc · Dark · Violet` (scheme, resolved mode,
accent); Wallpaper → `Fill screen · center center · 30 %`, or `No
wallpaper`.

The miniature reflects committed state only. Palette cards do not
hover-preview: scheme colours are `:root`-scoped in `index.css`, so a nested
element cannot render a different scheme.

### Voice

No preview. The controls column keeps its width; the preview column is
empty so nothing shifts.

## Sections and controls

Shared building blocks live in `components/settings/controls.tsx`:

- `SectionHeader` — section title, one-line description, and an optional
  **Reset** ghost button (`size="xs"`) on the right.
- `SettingRow` — label (`text-sm font-medium`) with optional description
  (`text-xs text-muted-foreground`), and a slot. Compact controls (switch,
  segmented) render inline on the right; wide controls (lists, grids,
  sliders) render below the label at full width.
- `SwitchRow` — `SettingRow` with a `Switch`.
- `Segmented` — a joined group of options (`bg-muted p-0.5 rounded-md`;
  active option `bg-background shadow-sm`), `role="radiogroup"`.
- `NumberField` — label, optional description, then on the right a stepper
  `[−] value [+]` (mono tabular value, buttons `size="icon-xs"`, disabled at
  the bounds), and a full-width `Slider` below. `stepValue(value, step,
  direction, min, max)` in `lib/settings.ts` does the arithmetic and rounds
  to the step's precision so `1.75 + 0.05` never shows as `1.8000000001`.
- `DropZone` — a dashed, rounded button-like area with an icon, a label and
  a hint line. Click opens a hidden `<input type="file">` with the given
  `accept`; dropping a file calls the same `onFile(file)`. Drag-over sets a
  `data-dragging` state styled `border-ring bg-accent`. Used by the
  wallpaper empty state and the voice-clone upload.

Section defaults: `lib/settings.ts` exports `SECTION_DEFAULTS` — the subset
of `DEFAULT_PREFS` each section's Reset restores:

| Section | Reset restores |
|---|---|
| Appearance | `resetTheme()` plus `uiScale`, `showClock` |
| Reading | `font`, `size`, `lineHeight`, `paraSpacing`, `width`, `justify`, `autoScroll` |
| Wallpaper | `wallpaperFit`, `wallpaperPos`, `wallpaperOpacity` (never deletes the image) |
| Voice | no reset |

The dialog's single "Reset appearance to defaults" button is removed;
`App.resetAll` goes with it.

### Appearance

1. **Theme** — `Segmented` Light / Dark / System with the existing icons.
2. **Palette** — 3×3 grid of buttons, each the scheme name (`text-sm`) over
   its five `SCHEME_PREVIEWS` dots for the resolved mode. Selected:
   `border-ring bg-secondary`; hover `bg-accent`. `aria-pressed`.
3. **Accent** — the five swatches at `size-7`, selected one ringed, with the
   selected accent's label to the right (`text-xs text-muted-foreground`).
4. **UI scale** — `NumberField` 85–150 step 5, shown as `100 %`. Description:
   "Bars, controls and this page. Reading text keeps its own size."
5. **Show clock** — `SwitchRow`.

### Reading

1. **Font** — `FontPicker` (below).
2. **Size** — `NumberField` 14–26 step 1, `18 px`.
3. **Line spacing** — `NumberField` 1.3–2.4 step 0.05, two decimals.
4. **Paragraph spacing** — `NumberField` 0.4–2.4 step 0.1, one decimal, `em`.
5. **Text width** — `NumberField` 34–60 step 1, unitless; description "How
   wide the column may grow. The preview caption shows it in pixels."
6. **Justify text** — `SwitchRow`, "Straight right edge, like a printed book."
7. **Auto-scroll** — `SwitchRow`, "Keep the sentence being read in view."

#### FontPicker

- A chip row: **All**, then one chip per `FONT_GROUPS` label. Chips are
  `Button size="xs"`, `secondary` when active, `ghost` otherwise.
  `filterFonts(filter)` in `lib/settings.ts` returns the groups to show.
- Below it a `role="radiogroup"` (`aria-label="Reading font"`) of rows, one
  per font, grouped under a small muted group label when **All** is active.
  Each row is `role="radio"` with `aria-checked`: the font name in its own
  face at 17px on the left, its `FONT_HINTS` hint right-aligned in muted
  12px. Selected row: `bg-secondary` with a check icon; hover `bg-accent`.
- Arrow keys move selection within the visible rows (roving tabindex);
  Home/End jump; the change commits on arrow move so the preview and the
  reader follow.
- `onPointerEnter` / `onFocus` on a row sets the hover font; `onPointerLeave`
  on the list / `onBlur` leaving the list clears it.
- No inner scroll box. The page scrolls; the preview is sticky.

### Wallpaper

1. **Image** — with a wallpaper: a thumbnail card (`aspect-video`, rounded,
   `object-cover`) beside **Replace image** and **Remove** (ghost,
   destructive on hover). Without one: a dashed drop zone (`border-dashed`)
   with an ImagePlus icon, "Choose image", and the hint "png, jpeg, gif or
   webp up to 200 MB". Both accept a dropped file as well as a click. Errors
   toast exactly as today.
2. **Fit** — `Segmented` over `WALLPAPER_FIT_LABELS`, wrapping on narrow
   widths.
3. **Position** — the existing 3×3 grid, disabled (40% opacity, no pointer
   events) when fit is `stretch`.
4. **Opacity** — `NumberField` 5–100 step 5, `30 %`.

Controls 2–4 render only when a wallpaper exists, as today.

### Voice

1. **Narrator** — `VoiceCombobox` at full width. Description: "Grouped by
   engine and language. Cloned voices appear under Cloned."
2. **Engine** and **Device** — `EngineModeList`, unchanged.
3. Qwen3 only:
   - **Style instruction** — the existing input and blur-commit behaviour,
     with the description "Applies to preset voices. Changing it regenerates
     audio."
   - **Clone a voice** — a dashed drop zone (click or drop) accepting
     `audio/*`, hint "3–30 s clip of one speaker · wav, flac or ogg". Upload,
     refresh and toasts as today.

## Files

New:

- `frontend/src/lib/view.ts` — `parseHash`, `hashFor`, `useView`.
- `frontend/src/lib/settings.ts` — `stepValue`, `formatValue`, `rovingNext`
  (arrow-key navigation shared by the segmented control and the font list),
  `SECTION_DEFAULTS`, `FONT_FILTERS`, `filterFonts`.
- `frontend/src/lib/view.test.ts`, `frontend/src/lib/settings.test.ts`,
  `frontend/src/lib/reading.test.ts`, `frontend/src/lib/wallpaper.test.ts`.
- `frontend/src/components/settings/SettingsPage.tsx` — shell: header, rail,
  section switch, preview slot, Escape handling.
- `frontend/src/components/settings/controls.tsx` — `SectionHeader`,
  `SettingRow`, `SwitchRow`, `Segmented`, `NumberField`, `DropZone`.
- `frontend/src/components/settings/AppearanceSection.tsx`,
  `ReadingSection.tsx`, `WallpaperSection.tsx`, `VoiceSection.tsx`.
- `frontend/src/components/settings/FontPicker.tsx`.
- `frontend/src/components/settings/ReadingPreview.tsx`.
- `frontend/src/components/settings/AppMiniature.tsx`.

Changed:

- `frontend/src/App.tsx` — view state, scroll save/restore, Escape, renders
  the page; drops `resetAll`.
- `frontend/src/components/TopBar.tsx` — new props, toggle button.
- `frontend/src/lib/reading.ts` — adds `readerMaxWidth`.
- `frontend/src/lib/wallpaper.ts` — adds `wallpaperFitStyle(fit, scale?)`,
  the fit → `background-size`/`-repeat` mapping moved out of `App.tsx`; the
  optional `scale` shrinks tile / actual-size images for the miniature.
- `frontend/src/components/Reader.tsx` — uses `readerMaxWidth`.
- `README.md` — the "Aa menu" bullet becomes the settings page.

Deleted: `frontend/src/components/SettingsDialog.tsx`. The shadcn
`ui/select.tsx` primitive becomes unused and is left in place.

## Testing

Pure logic has node tests under the existing vitest setup
(`src/**/*.test.ts`, node environment):

- `view.test.ts` — `parseHash` for `""`, `#`, `#settings`,
  `#settings/reading`, `#settings/bogus`, `#other`; `hashFor` round-trips.
- `settings.test.ts` — `stepValue` precision and clamping at both bounds
  for every step used (1, 5, 0.05, 0.1); `formatValue` decimals;
  `rovingNext` arrows, wrap, Home/End, and the filtered-out fallback;
  `SECTION_DEFAULTS` keys partition `DEFAULT_PREFS` and values match;
  `filterFonts("All")` returns every group in order and a group filter
  returns exactly that group.
- `wallpaper.test.ts` — `wallpaperFitStyle` for the five fits with and
  without a scale (cover/contain/stretch unchanged, tile and center
  scaled, never below 1px). `reading.test.ts` — `readerMaxWidth(44) === 800`.

Everything else is verified by running it: `npm run build -w frontend`
(type check + bundle), `npm run lint -w frontend`, `npm test -w frontend`,
then the dev server against the tunnelled backend with `agent-browser`
screenshots at 1440×900, 1024×768 and 390×844 in dark and light; keyboard
checks for Escape, browser back, and arrow keys in the font list; and a
visual check that the reader returns to its scroll position.

## Accessibility notes

- Rail and tab row expose `aria-current`; the font list is a radio group
  with roving tabindex; segmented controls are radio groups; palette and
  position buttons keep `aria-pressed`; swatches keep their labelled names.
- All motion runs under the existing `MotionConfig reducedMotion="user"`;
  the smooth scroll on section switch checks the media query directly.
- Hover preview never changes saved state; keyboard focus previews the same
  way so the pane is usable without a pointer.
