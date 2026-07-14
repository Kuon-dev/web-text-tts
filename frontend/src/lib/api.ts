export interface Chunk {
  id: string
  text: string
  para: number
}

export interface Doc {
  doc_id: string
  chunks: Chunk[]
  position: number
  voice: string
  speed: number
  volume?: number
}

export interface Status {
  doc_id: string
  ready: string[]
  failed: string[]
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

/** "af_heart" -> "Heart · US female" */
export function voiceLabel(id: string): string {
  const m = /^([ab])([fm])_(.+)$/.exec(id)
  if (!m) return id
  const accent = m[1] === "a" ? "US" : "UK"
  const gender = m[2] === "f" ? "female" : "male"
  const name = m[3].charAt(0).toUpperCase() + m[3].slice(1)
  return `${name} · ${accent} ${gender}`
}
