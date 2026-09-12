import { useSyncExternalStore } from "react"
// A UI package inside lib/, which vitest imports under `environment: "node"` —
// where there is no DOM at all, and a module that touches one at import time
// takes every test in this file down with it. sonner is safe because its
// module-scope DOM work is guarded by `typeof document`; that guard, not the
// package's popularity, is the thing to check before importing the next one
// here. (player.ts already pays this cost for `new Audio()`, which the tests
// stub.)
import { toast } from "sonner"
import {
  api,
  apiUrl,
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
import { dropStale, indexSet, nextAfter, prevBefore, toggle, type Mark } from "./bookmarks"
import { hud } from "./hud"
import { stepValue } from "./settings"
import { silentWavUrl } from "./silence"

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
  /** silence inserted between chunks (= sentences), at 1x speed */
  pauseMs: number
  muted: boolean
  voice: string
  voices: Voice[]
  instruct: string
  /** Marks in this chapter, in reading order — the palette lists these. */
  bookmarks: readonly Mark[]
  /** The same marks as positions. Carried separately, and kept in step with
   *  `bookmarks` by the engine, because the reader probes it once per sentence
   *  span across a ~10k-span tree that re-renders on every status poll —
   *  deriving a Set per render there is exactly the cost this avoids. */
  bookmarkSet: ReadonlySet<number>
  engine: EngineInfo | null
  /** engine id whose POST /api/state is still in flight, else null */
  switchingTo: string | null
  blocked: string | null
}

const RETRY_MS = 2000
const POLL_MS = 2000
const SAVE_DEBOUNCE_MS = 300

/** One id, so repeated presses replace rather than stack — the dock must never
 *  grow, and transient messages here are toasts, never inline chrome. */
const BOOKMARK_TOAST = "bookmark"

/** One keyboard nudge of volume or speed. Both share the step, and both match
 *  the dock sliders in dock/Modules.tsx, so the keys land on the same grid the
 *  mouse does and the two never disagree about what a legal value is. */
const NUDGE_STEP = 0.05
export const SPEED_MIN = 0.75
export const SPEED_MAX = 2
/** A key repeat arrives every ~30ms; the server only needs to hear where the
 *  value came to rest. */
const NUDGE_COMMIT_MS = 400

/**
 * Owns the <audio> element and all playback state. The generation-token /
 * retry / prefetch flow is ported from the original vanilla player; React
 * components subscribe via usePlayer().
 */
class PlayerEngine {
  private audio = new Audio()
  // Plays silence between sentences. A setTimeout cannot do this job: Chrome
  // clamps timers to 1s in a hidden tab and to ~1/minute once it has been
  // hidden a while without sound, which stalled a backgrounded reader between
  // every sentence. Media playback is never throttled that way.
  private gap = new Audio()
  private doc: Doc = { doc_id: "", chunks: [], position: 0, voice: "", speed: 1, volume: 1 }
  private idx = 0
  private marks: readonly Mark[] = []
  private markSet: ReadonlySet<number> = new Set()
  private playing = false
  private ready = new Set<string>()
  private failed = new Set<string>()
  private muted = false
  private durations: Record<string, number> = {}
  private playToken = 0
  // playToken value the pending silence belongs to; 0 when none is pending.
  private gapToken = 0
  private gapPrimed = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined
  // Bumped once per bookmark write; a reply only applies if it is still the
  // newest one in flight. See saveBookmarks.
  private bookmarkWrite = 0
  // Which fields a nudge has moved since the last commit; the values are read
  // off the doc when the timer fires, so only the resting value is ever sent.
  private nudged = new Set<"volume" | "speed">()
  private voices: Voice[] = []
  private engine: EngineInfo | null = null
  private switchingTo: string | null = null
  // Armed by setEngine, disarmed by the poll that sees the switch's load end.
  private pendingEngine: { id: string; sawLoading: boolean } | null = null
  private engineReadyListeners = new Set<(label: string) => void>()
  private blocked: string | null = null
  private started = false
  private listeners = new Set<() => void>()
  private snap: PlayerSnapshot

  constructor() {
    this.snap = this.buildSnapshot()
    this.audio.addEventListener("ended", () => this.advance())
    this.gap.addEventListener("ended", () => this.gapFinished())
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snap

  /** Fires once with the engine's label when a switch's model load finishes.
   *  Separate from subscribe(): "the wait is over" is an event, and a 40s load
   *  usually ends long after the user has left the settings page. */
  onEngineReady = (fn: (label: string) => void): (() => void) => {
    this.engineReadyListeners.add(fn)
    return () => {
      this.engineReadyListeners.delete(fn)
    }
  }

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
      pauseMs: this.doc.pause_ms ?? 0,
      muted: this.muted,
      voice: this.doc.voice,
      voices: this.voices,
      instruct: this.doc.instruct ?? "",
      bookmarks: this.marks,
      bookmarkSet: this.markSet,
      engine: this.engine,
      switchingTo: this.switchingTo,
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
    this.setMarks(dropStale(this.doc.bookmarks ?? [], this.doc.chunks))
    this.failed = new Set()
    this.ready = new Set()
    this.durations = {}
    this.audio.playbackRate = this.doc.speed
    this.audio.volume = this.doc.volume ?? 1
    this.emit()
  }

  /** Re-fetch the doc after a rechunk, preserving playback position. Covers both
   *  rechunks driven through setVoice/setEngine/setInstruct and ones that happen
   *  server-side outside those calls (e.g. deleting the active cloned voice). */
  async reconcileDoc() {
    const keep = this.idx
    await this.loadDoc()
    this.jump(keep)
  }

  private async pollStatus() {
    try {
      const s = await api<Status>("/api/status")
      if (s.engine) {
        this.engine = s.engine
        this.trackEngineLoad(s.engine)
      }
      this.blocked = s.blocked
      if (s.doc_id !== this.doc.doc_id) {
        // An agent appending a page mints a new doc_id, but the chunk being
        // spoken survives with the same id (and the same audio URL) — so
        // re-index and keep playing instead of stopping mid-sentence.
        const keepCid = this.playing ? this.doc.chunks[this.idx]?.id : undefined
        await this.loadDoc()
        const kept = keepCid ? this.doc.chunks.findIndex((c) => c.id === keepCid) : -1
        if (kept >= 0) {
          this.idx = kept
          this.playing = true
          this.emit()
        } else {
          this.audio.pause()
          this.playing = false
          this.emit()
        }
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
    this.stopGap()
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
    if (!this.playing) {
      this.emit()
      return
    }
    // Every chunk is one sentence (chunker.py), so this silence is the pause
    // between sentences.
    const pause = this.doc.pause_ms ?? 0
    if (pause <= 0) {
      this.playCurrent()
      return
    }
    this.gapToken = ++this.playToken
    this.emit() // highlight the next sentence while the silence plays
    this.gap.src = silentWavUrl(pause)
    // Played faster when the narrator is: a 500ms clip at 2x lasts 250ms.
    this.gap.playbackRate = this.doc.speed
    this.gap.play().catch(() => {
      // Autoplay policies can refuse the clip. Losing the pause beats
      // stranding playback, so fall through to the next sentence.
      if (this.playing && this.gapToken === this.playToken) this.gapFinished()
    })
  }

  /** Play (and immediately stop) the silence while the play click is still the
   *  current user gesture: Safari and iOS refuse an element that has never
   *  been started by one, and every later gap play happens unprompted. */
  private primeGap() {
    if (this.gapPrimed) return
    this.gapPrimed = true
    this.gap.src = silentWavUrl(1)
    this.gap.play().then(() => this.gap.pause()).catch(() => {})
  }

  /** The silence finished (or could not play): start the sentence it preceded. */
  private gapFinished() {
    if (this.gapToken !== this.playToken || !this.playing) return
    this.gapToken = 0
    this.playCurrent()
  }

  /** Abandon a silence in progress; a clip that ends anyway is then ignored. */
  private stopGap() {
    this.gapToken = 0
    this.gap.pause()
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

  /** Mark (or unmark) a sentence — by default the one the voice is on, which is
   *  what `b` means. The reader's context menu passes the line that was
   *  right-clicked instead, and marking it deliberately leaves the playhead
   *  alone: flagging a line you are *not* at is the gesture `b` cannot make.
   *
   *  An index no chunk answers to is ignored rather than stored. A negative
   *  index lands here too, since `chunks[-1]` is simply undefined. */
  toggleBookmark(at = this.idx) {
    const chunk = this.doc.chunks[at]
    if (!chunk) return
    const next = toggle(this.marks, at, chunk.text)
    const added = next.length > this.marks.length
    this.setMarks(next)
    this.emit()
    this.saveBookmarks()
    toast.message(added ? `Bookmarked sentence ${at + 1}` : `Bookmark removed`, {
      id: BOOKMARK_TOAST,
      duration: 1600,
    })
  }

  nextBookmark() {
    const i = nextAfter(this.marks, this.idx)
    if (i === null) this.sayThereAreNoMarks()
    else this.jump(i)
  }

  prevBookmark() {
    const i = prevBefore(this.marks, this.idx)
    if (i === null) this.sayThereAreNoMarks()
    else this.jump(i)
  }

  /** `n` on an unmarked chapter used to return in silence, which is exactly
   *  what a key bound to nothing at all looks like — and `n`/`⇧N` wrap, so on
   *  a chapter that does have marks they always move. The empty list is the
   *  only case that can look dead, so it is the only one that speaks. */
  private sayThereAreNoMarks() {
    toast.message("No bookmarks in this chapter", { id: BOOKMARK_TOAST, duration: 1600 })
  }

  private setMarks(marks: readonly Mark[]) {
    this.marks = marks
    this.markSet = indexSet(marks)
  }

  togglePlay() {
    if (!this.doc.chunks.length) return
    this.playing = !this.playing
    if (!this.playing) {
      this.audio.pause()
      this.stopGap()
      this.emit()
      return
    }
    this.primeGap()
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

  /** Speed ∓0.05× from the keyboard, over the range the dock slider offers. */
  nudgeSpeed(direction: 1 | -1) {
    this.setSpeed(stepValue(this.doc.speed, NUDGE_STEP, direction, SPEED_MIN, SPEED_MAX))
    hud.show("speed", this.doc.speed)
    this.commitNudge("speed")
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

  /** Volume ±5% from the keyboard. Raising it while muted unmutes, because
   *  setVolume unmutes for any value above zero — a listener reaching for the
   *  volume key means "let me hear it", whichever way they silenced it. */
  nudgeVolume(direction: 1 | -1) {
    this.setVolume(stepValue(this.doc.volume ?? 1, NUDGE_STEP, direction, 0, 1))
    hud.show("volume", this.doc.volume ?? 1)
    this.commitNudge("volume")
  }

  /** Persist a nudged value once the ramp settles. Un-debounced, a two-second
   *  hold of Shift+↑ would queue some sixty POSTs, each one a round trip that
   *  can outlive the key press it describes and land out of order. Volume and
   *  speed share the one timer and travel in one body — /api/state takes a
   *  partial patch — so a hand moving from volume to speed costs one request. */
  private commitNudge(field: "volume" | "speed") {
    this.nudged.add(field)
    clearTimeout(this.nudgeTimer)
    this.nudgeTimer = setTimeout(() => {
      const body: { volume?: number; speed?: number } = {}
      if (this.nudged.has("volume")) body.volume = this.doc.volume ?? 1
      if (this.nudged.has("speed")) body.speed = this.doc.speed
      this.nudged.clear()
      api("/api/state", body).catch(() => {})
    }, NUDGE_COMMIT_MS)
  }

  setPause(ms: number) {
    this.doc.pause_ms = Math.max(0, Math.round(ms))
    this.emit()
  }

  commitPause() {
    api("/api/state", { pause_ms: this.doc.pause_ms }).catch(() => {})
  }

  toggleMute() {
    this.muted = !this.muted
    this.audio.muted = this.muted
    this.emit()
  }

  /** Resolves true on success; throws (with the server's `detail` message when the
   *  rejection was a 400, via api()) on failure, after rolling back the optimistic update. */
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
    } catch (err) {
      this.engine = previous
      this.emit()
      throw err
    }
  }

  /** One-shot "the engine you switched to has finished loading".
   *
   *  Only a switch that actually paid a load gets announced: when the weights
   *  were already resident the switch itself was the whole wait, and the card
   *  already showed it. Staying armed until a load appears is deliberate — a
   *  switch made with no chapter open loads nothing until the next play, and
   *  that load is exactly the wait worth announcing. */
  private trackEngineLoad(info: EngineInfo) {
    const pending = this.pendingEngine
    if (!pending) return
    if (info.engine !== pending.id) {
      this.pendingEngine = null       // switched again; that switch owns the signal now
      return
    }
    if (info.loading) {
      pending.sawLoading = true
    } else if (pending.sawLoading) {
      this.pendingEngine = null
      this.engineReadyListeners.forEach((fn) => fn(info.label))
    }
  }

  /** Resolves true on success; throws (with the server's `detail` message when the
   *  rejection was a 400, via api()) on failure — the request is atomic, so nothing
   *  local needs rolling back. Resolves false without acting if a switch is already
   *  in flight: POST /api/state waits on EngineManager's lock behind the chunk in
   *  flight, which is long enough for an impatient second click. */
  async setEngine(id: string): Promise<boolean> {
    if (this.switchingTo !== null) return false
    this.switchingTo = id
    this.emit()
    try {
      const r = await api<{ rechunked: boolean }>("/api/state", { engine: id })
      if (this.engine) {
        // optimistic; the 2s status poll corrects label/gpu_available/mode/speed shortly
        this.engine = { ...this.engine, engine: id }
      }
      if (r.rechunked) await this.reconcileDoc()
      await this.refreshVoices()  // the new engine has its own voice set
      // The weights load lazily in the worker, well after this resolves.
      this.pendingEngine = { id, sawLoading: false }
      return true
    } finally {
      this.switchingTo = null
      this.emit()
    }
  }

  /** Returns true on success; false means the change failed (rejected atomically, nothing changed). */
  async setInstruct(text: string): Promise<boolean> {
    try {
      const r = await api<{ rechunked: boolean }>("/api/state", { instruct: text })
      this.doc.instruct = text
      if (r.rechunked) await this.reconcileDoc()
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
      if (r.rechunked) await this.reconcileDoc()
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
    this.stopGap()
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
    this.saveTimer = setTimeout(() => this.flushPosition(), SAVE_DEBOUNCE_MS)
  }

  /** Persist the position right now, cancelling any pending debounce.
   *  `keepalive` lets the request outlive a webview teardown — WKWebView and
   *  WebView2 do not reliably run beforeunload, so without this a quit
   *  mid-chapter loses up to SAVE_DEBOUNCE_MS of progress. */
  flushPosition() {
    if (!this.doc.chunks.length) return
    clearTimeout(this.saveTimer)
    fetch(apiUrl("/api/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position: this.idx }),
      keepalive: true,
    }).catch(() => {})
  }

  /** Persist the marks. Not debounced, unlike savePosition: a toggle is a
   *  discrete action rather than a moving value, so a debounce would only add
   *  a window in which the mark can be lost. The request is whole-list and
   *  idempotent, so repeated presses converge. `keepalive` for the same reason
   *  the position save uses it — WKWebView and WebView2 do not reliably run
   *  beforeunload.
   *
   *  `doc_id` rides along because the body is otherwise a bare list of indices
   *  that applies to whatever document the server holds *now*. An MCP
   *  `load_text`, a paste from another client, or the desktop shell can replace
   *  the document inside the 2s poll window, and a `b` press landing in that
   *  window would file this chapter's indices under the new `doc_id` — where
   *  the server fills in the new document's excerpts, so the client's dropStale
   *  has nothing to catch and keeps every one. Fabricated marks on a chapter
   *  nobody ever marked are indistinguishable from real ones; the server
   *  answers a mismatch by refusing the write and returning its own list.
   *
   *  Unlike flushPosition this reports its failures. A position is re-sent on
   *  every jump and every sentence advance, so a lost one self-heals within
   *  seconds; a mark is written once, on the toggle, so a silent failure leaves
   *  a phantom bar and tick on screen looking saved right up until the app
   *  closes, and then gone with nothing ever said. */
  private saveBookmarks() {
    // Which write this is, and which document it was taken from. Both are
    // checked before the response is applied, below.
    const write = ++this.bookmarkWrite
    const docId = this.doc.doc_id
    fetch(apiUrl("/api/bookmarks"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_id: docId, chunks: this.marks.map((m) => m.chunk) }),
      keepalive: true,
    })
      .then((r) => {
        // fetch rejects only on a *network* failure: a 422 from a malformed
        // body or a 500 from an unwritable state.json resolves like any other
        // response, so without this throw the catch below would never see the
        // failure that matters most — the one where the server is up and
        // refusing.
        if (!r.ok) throw new Error(String(r.status))
        // A body we cannot read is not a failed write: the 2xx already said the
        // marks landed, so a parse error must not reach the catch and report a
        // failure that did not happen.
        return r.json().catch(() => null)
      })
      .then((body: { bookmarks?: Mark[] } | null) => {
        // The route answers with the canonical stored list, so adopting it is
        // how the client converges on server truth after its own write: it
        // closes the case where the server truncated at MAX_MARKS, and the one
        // where it refused the write because the document had moved on. This
        // path deliberately issues no write of its own — a save that saved
        // again on its own reply is the one way this could loop.
        if (!Array.isArray(body?.bookmarks)) return
        // A newer toggle already owns the list, or the document was replaced
        // while this was in flight — responses are not ordered, and painting a
        // stale one back would either resurrect a mark the user just cleared or
        // draw another document's indices over this one's text.
        if (write !== this.bookmarkWrite || docId !== this.doc.doc_id) return
        // Re-anchored, not adopted wholesale. The guard above cannot catch a
        // refused write: the server answers a doc_id mismatch with the CURRENT
        // document's marks, and `this.doc.doc_id` only refreshes on the 2s
        // status poll — so after a swap both sides of that comparison still
        // read as the old document and the reply sails through. dropStale is a
        // no-op on the normal path (the same doc_id means the same chunk text,
        // chunker.py) and drops every index on the refused one, because another
        // chapter's excerpts cannot match this chapter's sentences.
        this.setMarks(dropStale(body.bookmarks, this.doc.chunks))
        this.emit()
      })
      // Through the id the toggle's success toast already used, so the error
      // replaces "Bookmarked sentence N" instead of stacking under a claim it
      // contradicts.
      .catch(() => toast.error("Bookmark not saved — is the server running?", { id: BOOKMARK_TOAST }))
  }
}

export const player = new PlayerEngine()

export function usePlayer(): PlayerSnapshot {
  return useSyncExternalStore(player.subscribe, player.getSnapshot)
}
