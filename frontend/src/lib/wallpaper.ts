import { useCallback, useEffect, useState } from "react"

export interface WallpaperInfo {
  id: string
  w: number
  h: number
  format: string
}

/** The id doubles as a cache-buster: the server serves the bytes immutable. */
export const wallpaperUrl = (info: WallpaperInfo) => `/api/wallpaper?v=${info.id}`

export function useWallpaper() {
  const [wallpaper, setWallpaper] = useState<WallpaperInfo | null>(null)

  useEffect(() => {
    let alive = true
    fetch("/api/wallpaper/info")
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
      const resp = await fetch("/api/wallpaper", { method: "POST", body: file })
      if (!resp.ok) return false
      setWallpaper((await resp.json()).wallpaper)
      return true
    } catch {
      return false
    }
  }, [])

  const remove = useCallback(async (): Promise<boolean> => {
    try {
      const resp = await fetch("/api/wallpaper", { method: "DELETE" })
      if (!resp.ok) return false
      setWallpaper(null)
      return true
    } catch {
      return false
    }
  }, [])

  return { wallpaper, upload, remove }
}
