/**
 * Silent WAV clips used to time the pause between sentences.
 *
 * The pause cannot be a setTimeout: Chrome clamps timers to one second in a
 * hidden tab, and throttles them to roughly once a minute once the tab has
 * been hidden for five minutes without emitting sound — so a backgrounded
 * reader stalled for many seconds between sentences (measured 2026-09-09:
 * setTimeout(300) fired at 1000ms hidden, while a 300ms clip ended at 374ms).
 * Playing an actual clip puts the wait on the media pipeline, which browsers
 * do not throttle, and keeps the tab counted as audible.
 *
 * 8 kHz 8-bit mono keeps the base64 small: the 2s maximum is ~21 KB.
 */
const RATE = 8000
const SILENT_SAMPLE = 0x80 // zero level for unsigned 8-bit PCM

const cache = new Map<number, string>()

function build(ms: number): string {
  const samples = Math.max(1, Math.round((RATE * ms) / 1000))
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + samples, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE, true) // byte rate = rate * channels * bytes per sample
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  ascii(36, "data")
  view.setUint32(40, samples, true)
  bytes.fill(SILENT_SAMPLE, 44)

  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return "data:audio/wav;base64," + btoa(binary)
}

/** A `data:` URI for `ms` of silence. Repeated durations reuse one string. */
export function silentWavUrl(ms: number): string {
  const key = Math.round(ms)
  let url = cache.get(key)
  if (url === undefined) {
    url = build(key)
    cache.set(key, url)
  }
  return url
}
