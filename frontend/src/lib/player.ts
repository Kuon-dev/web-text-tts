import { useSyncExternalStore } from "react"
import {
  api,
  audioUrl,
  getVoices,
  type Chunk,
  type DeviceMode,
  type Doc,
  type EngineInfo,
  type ImageRef,
  type Status,
  type Voice,
} from "./api"

export interface PlayerSnapshot {
  docId: string
  chunks: Chunk[]
  images: ImageRef[]
  idx: number
  playing: boolean
  ready: ReadonlySet<string>
  failed: ReadonlySet<string>
  speed: number
  volume: number
  muted: boolean
  voice: string
  voices: Voice[]
  instruct: string
  engine: EngineInfo | null
  blocked: string | null
}

const RETRY_MS = 2000
const POLL_MS = 2000
const SAVE_DEBOUNCE_MS = 300

/**
 * Owns the <audio> element and all playback state. The generation-token /
 * retry / prefetch flow is ported from the original vanilla player; React
 * components subscribe via usePlayer().
 */
class PlayerEngine {
  private audio = new Audio()
  private doc: Doc = { doc_id: "", chunks: [], position: 0, voice: "", speed: 1, volume: 1 }
  private idx = 0
  private playing = false
  private ready = new Set<string>()
  private failed = new Set<string>()
  private muted = false
  private durations: Record<string, number> = {}
  private playToken = 0
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private voices: Voice[] = []
  private engine: EngineInfo | null = null
  private blocked: string | null = null
  private started = false
  private listeners = new Set<() => void>()
  private snap: PlayerSnapshot

  constructor() {
    this.snap = this.buildSnapshot()
    this.audio.addEventListener("ended", () => this.advance())
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snap

  private emit() {
    this.snap = this.buildSnapshot()
    this.listeners.forEach((fn) => fn())
  }

  private buildSnapshot(): PlayerSnapshot {
    return {
      docId: this.doc.doc_id,
      chunks: this.doc.chunks,
      images: this.doc.images ?? [],
      idx: this.idx,
      playing: this.playing,
      ready: new Set(this.ready),
      failed: new Set(this.failed),
      speed: this.doc.speed,
      volume: this.doc.volume ?? 1,
      muted: this.muted,
      voice: this.doc.voice,
      voices: this.voices,
      instruct: this.doc.instruct ?? "",
      engine: this.engine,
      blocked: this.blocked,
    }
  }

  start() {
    if (this.started) return
    this.started = true
    this.loadVoices()
      .then(() => this.loadDoc())
      .catch(() => {})
      .finally(() => this.pollStatus())
  }

  private async loadVoices() {
    const v = await getVoices()
    this.voices = v.voices
    this.emit()
  }

  /** Re-fetch the voice list for the active engine (after a clone add/delete). */
  async refreshVoices() {
    try {
      await this.loadVoices()
    } catch {
      /* keep the stale list; next poll-driven action can retry */
    }
  }

  private async loadDoc(fresh?: Doc) {
    this.doc = fresh ?? (await api<Doc>("/api/doc"))
    this.idx = Math.min(this.doc.position, Math.max(this.doc.chunks.length - 1, 0))
    this.failed = new Set()
    this.ready = new Set()
    this.durations = {}
    this.audio.playbackRate = this.doc.speed
    this.audio.volume = this.doc.volume ?? 1
    this.emit()
  }

  private async pollStatus() {
    try {
      const s = await api<Status>("/api/status")
      if (s.engine) this.engine = s.engine
      this.blocked = s.blocked
      if (s.doc_id !== this.doc.doc_id) {
        this.audio.pause()
        this.playing = false
        await this.loadDoc()
      } else {
        this.ready = new Set(s.ready)
        if (s.durations) this.durations = s.durations
        s.failed.forEach((cid) => this.failed.add(cid))
        this.emit()
      }
    } catch {
      /* server restarting; keep polling */
    }
    setTimeout(() => this.pollStatus(), POLL_MS)
  }

  private async playCurrent(retries = 5) {
    const token = ++this.playToken
    if (this.idx >= this.doc.chunks.length) {
      this.playing = false
      this.emit()
      return
    }
    const cid = this.doc.chunks[this.idx].id
    if (this.failed.has(cid)) {
      this.advance()
      return
    }
    this.emit()
    this.audio.src = audioUrl(cid)
    this.audio.playbackRate = this.doc.speed
    try {
      await this.audio.play()
      this.prefetch(this.idx + 1)
    } catch {
      if (!this.playing || token !== this.playToken) return
      if (retries > 0) {
        setTimeout(() => {
          if (this.playing && token === this.playToken) this.playCurrent(retries - 1)
        }, RETRY_MS)
      } else {
        this.failed.add(cid)
        this.advance()
      }
    }
  }

  private prefetch(i: number) {
    if (i < this.doc.chunks.length) fetch(audioUrl(this.doc.chunks[i].id)).catch(() => {})
  }

  private advance() {
    if (this.idx + 1 >= this.doc.chunks.length) {
      this.playing = false
      this.emit()
      return
    }
    this.idx += 1
    this.savePosition()
    if (this.playing) this.playCurrent()
    else this.emit()
  }

  jump(i: number) {
    if (!this.doc.chunks.length) return
    this.idx = Math.max(0, Math.min(i, this.doc.chunks.length - 1))
    this.savePosition()
    if (this.playing) this.playCurrent()
    else this.emit()
  }

  /** Click on a chunk: clear its failed mark (allows retry) and jump to it. */
  clickChunk(i: number) {
    const chunk = this.doc.chunks[i]
    if (chunk) this.failed.delete(chunk.id)
    this.jump(i)
  }

  togglePlay() {
    if (!this.doc.chunks.length) return
    this.playing = !this.playing
    if (!this.playing) {
      this.audio.pause()
      this.emit()
      return
    }
    const chunk = this.doc.chunks[this.idx]
    const cid = chunk && chunk.id
    if (cid && this.audio.src.endsWith(audioUrl(cid)) && this.audio.currentTime > 0 && !this.audio.ended) {
      this.audio.play().catch(() => this.playCurrent())
      this.emit()
    } else {
      this.playCurrent()
    }
  }

  setSpeed(v: number) {
    this.doc.speed = v
    this.audio.playbackRate = v
    this.emit()
  }

  commitSpeed() {
    api("/api/state", { speed: this.doc.speed }).catch(() => {})
  }

  setVolume(v: number) {
    this.doc.volume = Math.max(0, Math.min(1, v))
    this.audio.volume = this.doc.volume
    if (this.doc.volume > 0 && this.muted) this.toggleMute()
    this.emit()
  }

  commitVolume() {
    api("/api/state", { volume: this.doc.volume }).catch(() => {})
  }

  toggleMute() {
    this.muted = !this.muted
    this.audio.muted = this.muted
    this.emit()
  }

  /** Returns true on success; false means the change failed and was rolled back. */
  async setDeviceMode(mode: DeviceMode): Promise<boolean> {
    const previous = this.engine
    if (this.engine) {
      // optimistic; the 2s status poll corrects `active`/`speed` shortly
      this.engine = { ...this.engine, mode, active: mode === "cpu" ? "cpu" : this.engine.active }
      this.emit()
    }
    try {
      await api("/api/state", { device_mode: mode })
      return true
    } catch {
      this.engine = previous
      this.emit()
      return false
    }
  }

  /** Returns true on success; false means the switch failed (rejected atomically, nothing changed). */
  async setEngine(id: string): Promise<boolean> {
    try {
      const r = await api<{ rechunked: boolean }>("/api/state", { engine: id })
      if (r.rechunked) {
        const keep = this.idx
        await this.loadDoc()
        this.jump(keep)
      }
      await this.refreshVoices()  // the new engine has its own voice set
      this.emit()
      return true
    } catch {
      this.emit()
      return false
    }
  }

  /** Returns true on success; false means the change failed (rejected atomically, nothing changed). */
  async setInstruct(text: string): Promise<boolean> {
    try {
      const r = await api<{ rechunked: boolean }>("/api/state", { instruct: text })
      this.doc.instruct = text
      if (r.rechunked) {
        const keep = this.idx
        await this.loadDoc()
        this.jump(keep)
      }
      this.emit()
      return true
    } catch {
      this.emit()
      return false
    }
  }

  /** Returns true on success; false means the change failed and was rolled back. */
  async setVoice(voice: string): Promise<boolean> {
    const previous = this.doc.voice
    try {
      const r = await api<{ rechunked: boolean }>("/api/state", { voice })
      this.doc.voice = voice
      if (r.rechunked) {
        const keep = this.idx
        await this.loadDoc()
        this.jump(keep)
      }
      this.emit()
      return true
    } catch {
      this.doc.voice = previous
      this.emit()
      return false
    }
  }

  /** Returns true on success; false means the server rejected the paste. */
  async pasteText(text: string): Promise<boolean> {
    this.audio.pause()
    this.playing = false
    try {
      const fresh = await api<Doc>("/api/doc", { text })
      await this.loadDoc(fresh)
      this.playing = true
      this.playCurrent()
      return true
    } catch {
      this.emit()
      return false
    }
  }

  /**
   * Elapsed / total chapter audio time in seconds, from real WAV durations.
   * Chunks not yet generated are estimated at the average of the known ones;
   * `estimated` flags that the total still contains guesses.
   */
  times(): { elapsed: number; total: number; estimated: boolean } {
    const ds = this.doc.chunks.map((c) => this.durations[c.id])
    const known = ds.filter((d): d is number => d !== undefined)
    if (!known.length) return { elapsed: 0, total: 0, estimated: ds.length > 0 }
    const avg = known.reduce((a, b) => a + b, 0) / known.length
    let elapsed = 0
    for (let i = 0; i < this.idx; i++) elapsed += ds[i] ?? avg
    const cid = this.doc.chunks[this.idx]?.id
    if (cid && this.audio.src.endsWith(audioUrl(cid)) && Number.isFinite(this.audio.currentTime)) {
      elapsed += Math.min(this.audio.currentTime, ds[this.idx] ?? this.audio.currentTime)
    }
    let total = 0
    for (const d of ds) total += d ?? avg
    return { elapsed, total, estimated: known.length < ds.length }
  }

  private savePosition() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      api("/api/state", { position: this.idx }).catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }
}

export const player = new PlayerEngine()

export function usePlayer(): PlayerSnapshot {
  return useSyncExternalStore(player.subscribe, player.getSnapshot)
}
