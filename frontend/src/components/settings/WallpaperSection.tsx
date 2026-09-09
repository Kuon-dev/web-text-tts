import { useRef } from "react"
import { ImagePlus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  WALLPAPER_FIT_LABELS,
  WALLPAPER_POS_X,
  WALLPAPER_POS_Y,
  type ReadingPrefs,
  type WallpaperFit,
} from "@/lib/reading"
import { SECTION_DEFAULTS } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { wallpaperUrl, type WallpaperInfo } from "@/lib/wallpaper"
import { DropZone, NumberField, SectionHeader, Segmented, SettingRow, useFileDrop } from "./controls"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  wallpaper: WallpaperInfo | null
  uploadWallpaper: (file: Blob) => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp"
const HINT = "png, jpeg, gif or webp up to 200 MB"

const FITS = (Object.keys(WALLPAPER_FIT_LABELS) as WallpaperFit[]).map((key) => ({ key, label: WALLPAPER_FIT_LABELS[key] }))

export function WallpaperSection({ prefs, update, wallpaper, uploadWallpaper, removeWallpaper }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (file: File) => {
    if (!(await uploadWallpaper(file))) toast.error(`Wallpaper upload failed — ${HINT}`)
  }
  const onRemove = async () => {
    if (!(await removeWallpaper())) toast.error("Couldn't remove wallpaper — is the server running?")
  }
  const { dragging, dropProps } = useFileDrop((f) => void onFile(f))

  return (
    <>
      <SectionHeader
        title="Wallpaper"
        description="A picture behind the tiles. Reset restores the layout and keeps the image."
        onReset={wallpaper ? () => update(SECTION_DEFAULTS.wallpaper) : undefined}
      />
      {wallpaper ? (
        <SettingRow label="Image" description="Drop a new picture on the thumbnail to replace it.">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ""
              if (f) void onFile(f)
            }}
          />
          <div className="flex items-center gap-4" {...dropProps}>
            <img
              src={wallpaperUrl(wallpaper)}
              alt=""
              className={cn("aspect-video w-40 shrink-0 rounded-md border object-cover transition-colors", dragging && "border-ring")}
            />
            <div className="flex flex-col items-start gap-1.5">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <ImagePlus aria-hidden />
                Replace image
              </Button>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void onRemove()}>
                <Trash2 aria-hidden />
                Remove
              </Button>
            </div>
          </div>
        </SettingRow>
      ) : (
        <DropZone Icon={ImagePlus} label="Choose image" hint={HINT} accept={ACCEPT} onFile={(f) => void onFile(f)} />
      )}
      {wallpaper && (
        <>
          <SettingRow label="Fit">
            <Segmented label="Wallpaper fit" value={prefs.wallpaperFit} options={FITS} onChange={(wallpaperFit) => update({ wallpaperFit })} />
          </SettingRow>
          <SettingRow
            label="Position"
            description={prefs.wallpaperFit === "stretch" ? "Stretch fills the screen, so position has no effect." : undefined}
            inline
          >
            <div
              role="group"
              aria-label="Wallpaper position"
              className={cn("grid w-fit grid-cols-3 gap-1", prefs.wallpaperFit === "stretch" && "pointer-events-none opacity-40")}
            >
              {WALLPAPER_POS_Y.map((y) =>
                WALLPAPER_POS_X.map((x) => {
                  const val = `${x} ${y}`
                  const active = prefs.wallpaperPos === val
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => update({ wallpaperPos: val })}
                      title={val}
                      aria-label={`Align ${val}`}
                      aria-pressed={active}
                      className={cn(
                        "grid size-6 cursor-pointer place-items-center rounded-sm border transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
                        active ? "border-ring bg-secondary" : "border-border",
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", active ? "bg-foreground" : "bg-muted-foreground/40")} />
                    </button>
                  )
                }),
              )}
            </div>
          </SettingRow>
          <NumberField
            label="Opacity"
            value={Math.round(prefs.wallpaperOpacity * 100)}
            min={5}
            max={100}
            step={5}
            unit="%"
            onChange={(v) => update({ wallpaperOpacity: v / 100 })}
          />
        </>
      )}
    </>
  )
}
