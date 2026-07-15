import { useRef, type ChangeEvent, type ReactNode } from "react"
import { ImagePlus, Monitor, Moon, Settings2, Sun, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { EngineModeList } from "@/components/EngineModePicker"
import { VoiceCombobox } from "@/components/VoiceCombobox"
import {
  FONT_LABELS,
  FONT_STACKS,
  WALLPAPER_FIT_LABELS,
  WALLPAPER_POS_X,
  WALLPAPER_POS_Y,
  type FontKey,
  type ReadingPrefs,
  type WallpaperFit,
} from "@/lib/reading"
import { ACCENT_LABELS, ACCENT_SWATCHES, type AccentKey, type ThemeMode, type ThemePrefs } from "@/lib/theme"
import { usePlayer } from "@/lib/player"
import { cn } from "@/lib/utils"
import type { WallpaperInfo } from "@/lib/wallpaper"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  theme: ThemePrefs
  updateTheme: (patch: Partial<ThemePrefs>) => void
  reset: () => void
  wallpaper: WallpaperInfo | null
  uploadWallpaper: (file: Blob) => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

const THEME_MODES: { key: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { key: "light", label: "Light", Icon: Sun },
  { key: "dark", label: "Dark", Icon: Moon },
  { key: "system", label: "System", Icon: Monitor },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
        <Separator />
      </div>
      {children}
    </section>
  )
}

function PrefRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      {children}
    </div>
  )
}

function SwitchRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function WallpaperSection({
  prefs,
  update,
  wallpaper,
  uploadWallpaper,
  removeWallpaper,
}: Pick<Props, "prefs" | "update" | "wallpaper" | "uploadWallpaper" | "removeWallpaper">) {
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!(await uploadWallpaper(file))) {
      toast.error("Wallpaper upload failed — png, jpeg, gif or webp up to 200MB")
    }
  }

  const onRemove = async () => {
    if (!(await removeWallpaper())) {
      toast.error("Couldn't remove wallpaper — is the server running?")
    }
  }

  return (
    <Section title="Wallpaper">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => void onFile(e)}
      />
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => fileRef.current?.click()}>
          <ImagePlus className="size-3.5" aria-hidden />
          {wallpaper ? "Replace image" : "Choose image"}
        </Button>
        {wallpaper && (
          <Button variant="ghost" size="sm" onClick={() => void onRemove()} title="Remove wallpaper" aria-label="Remove wallpaper">
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      {wallpaper && (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Label className="text-xs text-muted-foreground">Size</Label>
              <Select value={prefs.wallpaperFit} onValueChange={(v) => update({ wallpaperFit: v as WallpaperFit })}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(WALLPAPER_FIT_LABELS) as WallpaperFit[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {WALLPAPER_FIT_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Position</Label>
              <div
                className={cn("grid w-fit grid-cols-3 gap-1", prefs.wallpaperFit === "stretch" && "pointer-events-none opacity-40")}
                role="group"
                aria-label="Wallpaper position"
              >
                {WALLPAPER_POS_Y.map((y) =>
                  WALLPAPER_POS_X.map((x) => {
                    const val = `${x} ${y}`
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => update({ wallpaperPos: val })}
                        title={val}
                        aria-label={`Align ${val}`}
                        aria-pressed={prefs.wallpaperPos === val}
                        className={cn(
                          "grid size-6 cursor-pointer place-items-center rounded-sm border transition-colors hover:bg-accent",
                          prefs.wallpaperPos === val ? "border-ring bg-secondary" : "border-border",
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            prefs.wallpaperPos === val ? "bg-foreground" : "bg-muted-foreground/40",
                          )}
                        />
                      </button>
                    )
                  }),
                )}
              </div>
            </div>
          </div>
          <PrefRow label="Opacity" value={`${Math.round(prefs.wallpaperOpacity * 100)}%`}>
            <Slider
              value={[Math.round(prefs.wallpaperOpacity * 100)]}
              min={5}
              max={100}
              step={5}
              onValueChange={([v]) => update({ wallpaperOpacity: v / 100 })}
            />
          </PrefRow>
        </>
      )}
    </Section>
  )
}

export function SettingsDialog({ prefs, update, theme, updateTheme, reset, wallpaper, uploadWallpaper, removeWallpaper }: Props) {
  const { voice, voices, engine } = usePlayer()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" title="Settings" aria-label="Settings">
          <Settings2 className="size-3.5" aria-hidden />
          <span className="max-sm:hidden">Settings</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance, wallpaper, reading and voice preferences.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-10 gap-y-7 px-6 py-5 sm:grid-cols-2">
          <div className="space-y-7">
            <Section title="Appearance">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Theme</Label>
                <div className="grid grid-cols-3 gap-1">
                  {THEME_MODES.map(({ key, label, Icon }) => (
                    <Button
                      key={key}
                      variant={theme.mode === key ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => updateTheme({ mode: key })}
                      aria-pressed={theme.mode === key}
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Accent</Label>
                <div className="flex items-center gap-2">
                  {(Object.keys(ACCENT_LABELS) as AccentKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => updateTheme({ accent: k })}
                      title={ACCENT_LABELS[k]}
                      aria-label={`${ACCENT_LABELS[k]} accent`}
                      aria-pressed={theme.accent === k}
                      className={cn(
                        "size-6 cursor-pointer rounded-full border border-black/20 transition-[transform,box-shadow] duration-200 hover:scale-110 active:scale-95 dark:border-white/20",
                        theme.accent === k && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                      )}
                      style={{ background: ACCENT_SWATCHES[k] }}
                    />
                  ))}
                </div>
              </div>
            </Section>

            <Section title="Reading">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Font</Label>
                <Select value={prefs.font} onValueChange={(v) => update({ font: v as FontKey })}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(FONT_LABELS) as FontKey[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        <span style={{ fontFamily: FONT_STACKS[k] }}>{FONT_LABELS[k]}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <PrefRow label="Size" value={`${prefs.size}px`}>
                <Slider value={[prefs.size]} min={14} max={26} step={1} onValueChange={([v]) => update({ size: v })} />
              </PrefRow>
              <PrefRow label="Line spacing" value={prefs.lineHeight.toFixed(2)}>
                <Slider
                  value={[prefs.lineHeight]}
                  min={1.3}
                  max={2.4}
                  step={0.05}
                  onValueChange={([v]) => update({ lineHeight: v })}
                />
              </PrefRow>
              <PrefRow label="Paragraph spacing" value={prefs.paraSpacing.toFixed(1)}>
                <Slider
                  value={[prefs.paraSpacing]}
                  min={0.4}
                  max={2.4}
                  step={0.1}
                  onValueChange={([v]) => update({ paraSpacing: v })}
                />
              </PrefRow>
              <PrefRow label="Text width" value={`${prefs.width}`}>
                <Slider value={[prefs.width]} min={34} max={60} step={1} onValueChange={([v]) => update({ width: v })} />
              </PrefRow>
              <SwitchRow id="pref-justify" label="Justify text" checked={prefs.justify} onChange={(v) => update({ justify: v })} />
              <SwitchRow
                id="pref-autoscroll"
                label="Auto-scroll to sentence"
                checked={prefs.autoScroll}
                onChange={(v) => update({ autoScroll: v })}
              />
            </Section>
          </div>

          <div className="space-y-7">
            <WallpaperSection
              prefs={prefs}
              update={update}
              wallpaper={wallpaper}
              uploadWallpaper={uploadWallpaper}
              removeWallpaper={removeWallpaper}
            />

            <Section title="Voice">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Narrator</Label>
                <VoiceCombobox voice={voice} voices={voices} className="w-full" />
              </div>
              <EngineModeList engine={engine} />
            </Section>
          </div>
        </div>
        <div className="border-t px-6 py-3">
          <Button variant="ghost" size="sm" className="w-full" onClick={reset}>
            Reset appearance to defaults
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
