import { useEffect, useState } from "react"
import { Clock as ClockIcon } from "lucide-react"
import { cn } from "@/lib/utils"

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

/** Dock clock module, the bar's rightmost item; hover for the full date. */
export function Clock({ className }: { className?: string }) {
  const now = useNow()
  return (
    <span
      className={cn("flex h-7 items-center gap-1.5 px-2 font-mono text-xs tabular-nums text-muted-foreground select-none", className)}
      title={now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
    >
      <ClockIcon className="size-3.5 text-(--mod-clock)" aria-hidden />
      <time dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </span>
  )
}
