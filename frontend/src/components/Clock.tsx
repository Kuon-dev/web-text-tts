import { useEffect, useState } from "react"

/** Re-renders on the minute boundary so the clock never shows a stale minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: number
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date())
        schedule()
      }, 60_000 - (Date.now() % 60_000) + 50)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [])
  return now
}

export function Clock() {
  const now = useNow()
  return (
    <div
      className="fixed top-14 right-4 z-10 rounded-md border bg-background/80 px-2.5 py-1 text-xs tabular-nums text-muted-foreground backdrop-blur select-none"
      title={now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
    >
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </div>
  )
}
