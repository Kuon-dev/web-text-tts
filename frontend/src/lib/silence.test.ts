import { expect, it } from "vitest"

import { silentWavUrl } from "./silence"

function decode(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1)
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

it("builds a data: URI holding a WAV of the requested duration", () => {
  const url = silentWavUrl(300)
  expect(url.startsWith("data:audio/wav;base64,")).toBe(true)
  const bytes = decode(url)
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF")
  expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE")
  // 8 kHz, 8-bit mono -> one byte per sample, so 300ms is 2400 sample bytes.
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(40, true)).toBe(2400)
  expect(bytes.length).toBe(44 + 2400)
})

it("fills the samples with silence", () => {
  const bytes = decode(silentWavUrl(50))
  // 0x80 is the zero level for unsigned 8-bit PCM; 0x00 would be full-scale.
  expect(bytes.slice(44).every((b) => b === 0x80)).toBe(true)
})

it("returns the identical string for a repeated duration", () => {
  // The player swaps this into an <audio> src on every sentence boundary;
  // rebuilding the base64 each time would churn memory for no reason.
  expect(silentWavUrl(300)).toBe(silentWavUrl(300))
  expect(silentWavUrl(300)).not.toBe(silentWavUrl(500))
})
