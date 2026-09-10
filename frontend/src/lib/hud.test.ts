import { afterEach, beforeEach, expect, it, vi } from "vitest"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A fresh module graph per test: the store is a singleton, and a pending
 *  hold from the previous test would otherwise decide when this one expires. */
async function freshHud() {
  vi.resetModules()
  const { hud } = await import("./hud")
  return hud
}

it("shows a value and takes it down once the hold runs out", async () => {
  const hud = await freshHud()
  expect(hud.getSnapshot()).toBe(null)

  hud.show("volume", 0.6)
  expect(hud.getSnapshot()).toMatchObject({ kind: "volume", value: 0.6 })

  vi.advanceTimersByTime(1199)
  expect(hud.getSnapshot()).not.toBe(null)
  vi.advanceTimersByTime(1)
  expect(hud.getSnapshot()).toBe(null)
})

it("restarts the hold on every show, so a held key keeps the pill up", async () => {
  const hud = await freshHud()
  hud.show("speed", 1.05)
  vi.advanceTimersByTime(1000)
  hud.show("speed", 1.1)

  // Under a single un-restarted timer the first show would have expired here.
  vi.advanceTimersByTime(1000)
  expect(hud.getSnapshot()).toMatchObject({ kind: "speed", value: 1.1 })
  vi.advanceTimersByTime(200)
  expect(hud.getSnapshot()).toBe(null)
})

it("bumps seq even when the value has not moved", async () => {
  const hud = await freshHud()
  // What leaning on Shift+↑ at 100% looks like: nothing changes but the key
  // did arrive, and the pill has to acknowledge it.
  hud.show("volume", 1)
  const first = hud.getSnapshot()
  hud.show("volume", 1)
  const second = hud.getSnapshot()

  expect(second?.seq).toBe((first?.seq ?? 0) + 1)
  expect(second).not.toBe(first) // a new snapshot object, so React re-renders
})

it("notifies subscribers on show and on expiry, and stops once unsubscribed", async () => {
  const hud = await freshHud()
  let notifications = 0
  const unsubscribe = hud.subscribe(() => {
    notifications += 1
  })

  hud.show("volume", 0.5)
  expect(notifications).toBe(1)
  vi.advanceTimersByTime(1200)
  expect(notifications).toBe(2)

  unsubscribe()
  hud.show("volume", 0.55)
  expect(notifications).toBe(2)
})

it("hides immediately when asked, without leaving the hold armed", async () => {
  const hud = await freshHud()
  hud.show("speed", 1.5)
  hud.hide()
  expect(hud.getSnapshot()).toBe(null)

  // The dropped timer must not fire a second, pointless notification later.
  let notifications = 0
  hud.subscribe(() => {
    notifications += 1
  })
  vi.advanceTimersByTime(2000)
  expect(notifications).toBe(0)
})
