import { BookAudio, ClipboardPaste } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ReadingMenu } from "@/components/ReadingMenu"
import type { ReadingPrefs } from "@/lib/reading"
import type { ThemePrefs } from "@/lib/theme"
import type { WallpaperInfo } from "@/lib/wallpaper"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  theme: ThemePrefs
  updateTheme: (patch: Partial<ThemePrefs>) => void
  reset: () => void
  onPasteClick: () => void
  wallpaper: WallpaperInfo | null
  uploadWallpaper: (file: Blob) => Promise<boolean>
  removeWallpaper: () => Promise<boolean>
}

export function TopBar({ prefs, update, theme, updateTheme, reset, onPasteClick, wallpaper, uploadWallpaper, removeWallpaper }: Props) {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
      <div className="mx-auto flex h-12 max-w-5xl items-center gap-2.5 px-4">
        <BookAudio className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">novel-tts</span>
        <div className="ml-auto flex items-center gap-2">
          <ReadingMenu
            prefs={prefs}
            update={update}
            theme={theme}
            updateTheme={updateTheme}
            reset={reset}
            wallpaper={wallpaper}
            uploadWallpaper={uploadWallpaper}
            removeWallpaper={removeWallpaper}
          />
          <Button size="sm" onClick={onPasteClick}>
            <ClipboardPaste data-icon="inline-start" aria-hidden />
            Paste chapter
          </Button>
        </div>
      </div>
    </header>
  )
}
