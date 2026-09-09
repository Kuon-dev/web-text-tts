import { useCallback, useEffect, useState, type CSSProperties } from "react"
import { apiUrl } from "./api"
import type { WallpaperFit } from "./reading"

export interface WallpaperInfo {
  id: string
  w: number
  h: number
  format: string
}

/** The id doubles as a cache-buster: the server serves the bytes immutable. */
export const wallpaperUrl = (info: WallpaperInfo) => apiUrl(`/api/wallpaper?v=${info.id}`)

/** background-size / -repeat for a wallpaper fit. `cover`, `contain` and
 *  `stretch` are relative to their box; `tile` and `center` use the image's
 *  natural size, which `scale` shrinks for the settings miniature
 *  (ratio = miniature width / viewport width). */
export function wallpaperFitStyle(fit: WallpaperFit, scale?: { w: number; h: number; ratio: number }): CSSProperties {
  const natural = scale
    ? `${Math.max(1, Math.round(scale.w * scale.ratio))}px ${Math.max(1, Math.round(scale.h * scale.ratio))}px`
    : "auto"
  switch (fit) {
    case "cover":
      return { backgroundSize: "cover", backgroundRepeat: "no-repeat" }
    case "contain":
      return { backgroundSize: "contain", backgroundRepeat: "no-repeat" }
    case "stretch":
      return { backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" }
    case "tile":
      return { backgroundSize: natural, backgroundRepeat: "repeat" }
    case "center":
      return { backgroundSize: natural, backgroundRepeat: "no-repeat" }
  }
}

export function useWallpaper() {
  const [wallpaper, setWallpaper] = useState<WallpaperInfo | null>(null)

  useEffect(() => {
    let alive = true
    fetch(apiUrl("/api/wallpaper/info"))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j) setWallpaper(j.wallpaper ?? null)
      })
      .catch(() => {
        /* server down — status polling will surface that elsewhere */
      })
    return () => {
      alive = false
    }
  }, [])

  const upload = useCallback(async (file: Blob): Promise<boolean> => {
    try {
      const resp = await fetch(apiUrl("/api/wallpaper"), { method: "POST", body: file })
      if (!resp.ok) return false
      setWallpaper((await resp.json()).wallpaper)
      return true
    } catch {
      return false
    }
  }, [])

  const remove = useCallback(async (): Promise<boolean> => {
    try {
      const resp = await fetch(apiUrl("/api/wallpaper"), { method: "DELETE" })
      if (!resp.ok) return false
      setWallpaper(null)
      return true
    } catch {
      return false
    }
  }, [])

  return { wallpaper, upload, remove }
}
