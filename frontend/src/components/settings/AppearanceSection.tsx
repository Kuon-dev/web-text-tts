import { Monitor, Moon, Sun } from "lucide-react"
import type { ReadingPrefs } from "@/lib/reading"
import { SECTION_DEFAULTS } from "@/lib/settings"
import {
  ACCENT_LABELS,
  ACCENT_SWATCHES,
  SCHEME_LABELS,
  SCHEME_PREVIEWS,
  type AccentKey,
  type SchemeKey,
  type ThemeMode,
  type ThemePrefs,
} from "@/lib/theme"
import { cn } from "@/lib/utils"
import { NumberField, SectionHeader, Segmented, SettingRow, SwitchRow } from "./controls"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  theme: ThemePrefs
  dark: boolean
  updateTheme: (patch: Partial<ThemePrefs>) => void
  resetTheme: () => void
}

const THEME_MODES: { key: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { key: "light", label: "Light", Icon: Sun },
  { key: "dark", label: "Dark", Icon: Moon },
  { key: "system", label: "System", Icon: Monitor },
]

/** The five accent hues a scheme ships with. */
function PaletteDots({ colors }: { colors: string[] }) {
  return (
    <span aria-hidden className="flex items-center gap-1">
      {colors.map((c, i) => (
        <span key={i} className="size-2 rounded-full" style={{ background: c }} />
      ))}
    </span>
  )
}

export function AppearanceSection({ prefs, update, theme, dark, updateTheme, resetTheme }: Props) {
  const previewMode = dark ? "dark" : "light"
  return (
    <>
      <SectionHeader
        title="Appearance"
        description="Theme, palette and the size of the chrome."
        onReset={() => {
          resetTheme()
          update(SECTION_DEFAULTS.appearance)
        }}
      />
      <SettingRow label="Theme">
        <Segmented label="Theme" value={theme.mode} options={THEME_MODES} onChange={(mode) => updateTheme({ mode })} />
      </SettingRow>
      <SettingRow label="Palette" description="Terminal colour schemes; each brings its own accent hues.">
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(SCHEME_LABELS) as SchemeKey[]).map((k) => {
            const active = theme.scheme === k
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => updateTheme({ scheme: k })}
                className={cn(
                  "flex cursor-pointer flex-col items-start gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "border-ring bg-secondary" : "border-border",
                )}
              >
                <span className="text-sm">{SCHEME_LABELS[k]}</span>
                <PaletteDots colors={SCHEME_PREVIEWS[k][previewMode]} />
              </button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow label="Accent" description="Sentence highlight, focused-window glow and progress.">
        <div className="flex items-center gap-2.5">
          {(Object.keys(ACCENT_LABELS) as AccentKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => updateTheme({ accent: k })}
              title={ACCENT_LABELS[k]}
              aria-label={`${ACCENT_LABELS[k]} accent`}
              aria-pressed={theme.accent === k}
              className={cn(
                "size-7 cursor-pointer rounded-full border border-black/20 transition-[transform,box-shadow] duration-200 outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95 dark:border-white/20",
                theme.accent === k && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ background: ACCENT_SWATCHES[k] }}
            />
          ))}
          <span className="ml-1 text-xs text-muted-foreground">{ACCENT_LABELS[theme.accent]}</span>
        </div>
      </SettingRow>
      <NumberField
        label="UI scale"
        description="Bars, controls and this page. Reading text keeps its own size."
        value={Math.round(prefs.uiScale * 100)}
        min={85}
        max={150}
        step={5}
        unit="%"
        onChange={(v) => update({ uiScale: v / 100 })}
      />
      <SwitchRow id="pref-clock" label="Show clock" description="At the right end of the dock." checked={prefs.showClock} onChange={(showClock) => update({ showClock })} />
    </>
  )
}
