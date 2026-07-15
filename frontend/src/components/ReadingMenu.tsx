import { useRef, type ChangeEvent, type ReactNode } from "react"
import { ImagePlus, Monitor, Moon, Sun, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { FONT_LABELS, FONT_STACKS, type FontKey, type ReadingPrefs } from "@/lib/reading"
import { ACCENT_LABELS, ACCENT_SWATCHES, type AccentKey, type ThemeMode, type ThemePrefs } from "@/lib/theme"
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
      toast.error("Wallpaper upload failed — png, jpeg, gif or webp up to 25MB")
    }
  }

  const onRemove = async () => {
    if (!(await removeWallpaper())) {
      toast.error("Couldn't remove wallpaper — is the server running?")
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Wallpaper</Label>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => void onFile(e)} />
        <div className="flex gap-1.5">
          <Button variant="outline" size="xs" className="flex-1" onClick={() => fileRef.current?.click()}>
            <ImagePlus className="size-3.5" aria-hidden />
            {wallpaper ? "Replace image" : "Choose image"}
          </Button>
          {wallpaper && (
            <Button variant="ghost" size="xs" onClick={() => void onRemove()} title="Remove wallpaper" aria-label="Remove wallpaper">
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {wallpaper && (
        <PrefRow label="Wallpaper opacity" value={`${Math.round(prefs.wallpaperOpacity * 100)}%`}>
          <Slider
            value={[Math.round(prefs.wallpaperOpacity * 100)]}
            min={5}
            max={100}
            step={5}
            onValueChange={([v]) => update({ wallpaperOpacity: v / 100 })}
          />
        </PrefRow>
      )}
    </div>
  )
}

export function ReadingMenu({ prefs, update, theme, updateTheme, reset, wallpaper, uploadWallpaper, removeWallpaper }: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title="Appearance & reading settings" aria-label="Appearance & reading settings">
          <span className="font-serif text-sm leading-none">Aa</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[80vh] w-72 overflow-y-auto">
        <div className="space-y-4">
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
                    theme.accent === k && "ring-2 ring-ring ring-offset-2 ring-offset-popover",
                  )}
                  style={{ background: ACCENT_SWATCHES[k] }}
                />
              ))}
            </div>
          </div>

          <Separator />

          <WallpaperSection
            prefs={prefs}
            update={update}
            wallpaper={wallpaper}
            uploadWallpaper={uploadWallpaper}
            removeWallpaper={removeWallpaper}
          />

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Reading font</Label>
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

          <Separator />

          <SwitchRow id="pref-justify" label="Justify text" checked={prefs.justify} onChange={(v) => update({ justify: v })} />
          <SwitchRow
            id="pref-autoscroll"
            label="Auto-scroll to sentence"
            checked={prefs.autoScroll}
            onChange={(v) => update({ autoScroll: v })}
          />

          <Separator />

          <Button variant="ghost" size="sm" className="w-full" onClick={reset}>
            Reset to defaults
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
