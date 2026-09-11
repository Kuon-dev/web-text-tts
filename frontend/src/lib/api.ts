import type { Mark } from "./bookmarks"

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
  /** silence the player inserts between chunks (= sentences) */
  pause_ms?: number
  instruct?: string
  images?: ImageRef[]
  bookmarks?: Mark[]
}

export type DeviceMode = "auto" | "gpu" | "cpu"

export interface Voice {
  id: string
  name: string
  group: string
  language: string
}

export interface EngineEntry {
  id: string
  label: string
  available: boolean
  reason: string | null
  supported_modes: DeviceMode[]
}

export interface EngineInfo {
  engine: string
  label: string
  mode: DeviceMode
  active: "gpu" | "cpu"
  gpu_available: boolean
  /** weights are being loaded right now (tens of seconds; minutes on a first download) */
  loading: boolean
  speed: number
}

export interface Status {
  doc_id: string
  ready: string[]
  failed: string[]
  /** seconds of audio per ready chunk id */
  durations?: Record<string, number>
  blocked: string | null
  engine?: EngineInfo
}

declare global {
  interface Window {
    __API_BASE__?: string
  }
}

/**
 * Origin of the Python server. "" = same-origin: the web app and the vite dev
 * proxy. The desktop shell sets window.__API_BASE__ before the app mounts.
 *
 * Read at CALL time, never at module-eval time, so the Rust-side injection can
 * land after this module has been evaluated.
 *
 * Read via globalThis rather than window: in every real browser/webview
 * window IS globalThis, so this is equivalent there, but it also works in the
 * plain-node environment the unit tests run under, where `window` does not
 * exist at all.
 *
 * INVARIANT: no trailing slash and no query string. player.ts compares
 * `audio.src.endsWith(audioUrl(cid))`, which only holds while the base is a
 * bare origin.
 */
const base = () =>
  (globalThis as { __API_BASE__?: string }).__API_BASE__ ??
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  ""

export const apiUrl = (path: string) => base() + path

export async function api<T>(path: string, body?: unknown, method?: string, raw?: boolean): Promise<T> {
  const init: RequestInit = {}
  if (method) init.method = method
  if (body !== undefined) {
    init.method = method ?? "POST"
    init.body = raw ? (body as BodyInit) : JSON.stringify(body)
    if (!raw) init.headers = { "Content-Type": "application/json" }
  }
  const resp = await fetch(apiUrl(path), init)
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === "string" ? body.detail : `${path}: ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

export const getEngines = () => api<{ engines: EngineEntry[]; current: string }>("/api/engines")
export const getVoices = () => api<{ voices: Voice[]; current: string }>("/api/voices")
export const uploadClone = (name: string, data: ArrayBuffer) =>
  api<{ voice: Voice }>(`/api/voices/clone?name=${encodeURIComponent(name)}`, data, "POST", true)
export const deleteClone = (id: string) =>
  api<{ ok: boolean }>(`/api/voices/${encodeURIComponent(id)}`, undefined, "DELETE")
export const voiceLabel = (v: Voice) => `${v.name} · ${v.group}`

export const audioUrl = (cid: string) => apiUrl(`/api/audio/${cid}`)

export const imageUrl = (iid: string) => apiUrl(`/api/image/${iid}`)

export interface ImageInfo {
  id: string
  w: number
  h: number
}

/** Upload raw image bytes (clipboard bitmap or decoded data: URI). */
export async function uploadImage(blob: Blob): Promise<ImageInfo> {
  const resp = await fetch(apiUrl("/api/image"), { method: "POST", body: blob })
  if (!resp.ok) throw new Error(`upload: ${resp.status}`)
  return resp.json() as Promise<ImageInfo>
}

/** Ask the server to download an image URL from a pasted chapter. */
export const importImageUrl = (url: string) => api<ImageInfo>("/api/image/fetch", { url })
