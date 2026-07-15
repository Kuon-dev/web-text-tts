export interface Chunk {
  id: string
  text: string
  para: number
}

export interface ImageRef {
  id: string
  para: number
  w: number
  h: number
}

export interface Doc {
  doc_id: string
  chunks: Chunk[]
  position: number
  voice: string
  speed: number
  volume?: number
  images?: ImageRef[]
}

export type EngineMode = "auto" | "gpu" | "cpu"

export interface EngineInfo {
  mode: EngineMode
  active: "gpu" | "cpu"
  gpu_available: boolean
  speed: number
}

export interface Status {
  doc_id: string
  ready: string[]
  failed: string[]
  /** seconds of audio per ready chunk id */
  durations?: Record<string, number>
  engine?: EngineInfo
}

export interface VoicesResponse {
  voices: string[]
  current: string
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  )
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`)
  return resp.json() as Promise<T>
}

export const audioUrl = (cid: string) => `/api/audio/${cid}`

export const imageUrl = (iid: string) => `/api/image/${iid}`

export interface ImageInfo {
  id: string
  w: number
  h: number
}

/** Upload raw image bytes (clipboard bitmap or decoded data: URI). */
export async function uploadImage(blob: Blob): Promise<ImageInfo> {
  const resp = await fetch("/api/image", { method: "POST", body: blob })
  if (!resp.ok) throw new Error(`upload: ${resp.status}`)
  return resp.json() as Promise<ImageInfo>
}

/** Ask the server to download an image URL from a pasted chapter. */
export const importImageUrl = (url: string) => api<ImageInfo>("/api/image/fetch", { url })

/** "af_heart" -> "Heart · US female" */
export function voiceLabel(id: string): string {
  const m = /^([ab])([fm])_(.+)$/.exec(id)
  if (!m) return id
  return `${voiceName(id)} · ${voiceGroup(id)}`
}

/** "af_heart" -> "US female"; unparsable ids -> "Other" */
export function voiceGroup(id: string): string {
  const m = /^([ab])([fm])_/.exec(id)
  if (!m) return "Other"
  return `${m[1] === "a" ? "US" : "UK"} ${m[2] === "f" ? "female" : "male"}`
}

/** "af_heart" -> "Heart" */
export function voiceName(id: string): string {
  const m = /^[ab][fm]_(.+)$/.exec(id)
  const name = m ? m[1] : id
  return name.charAt(0).toUpperCase() + name.slice(1)
}
