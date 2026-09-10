import type { ReactNode } from "react"
import { m } from "motion/react"
import type { LucideIcon } from "lucide-react"
import type { Transition } from "motion/react"
import { cn } from "@/lib/utils"

const BRACKET_SPRING: Transition = { type: "spring", stiffness: 300, damping: 28 }

/** A sketchybar bracket: related items share one recessed pill, so the bar
 *  reads as three groups rather than a row of a dozen buttons. The pill sits
 *  a step below the bar's frosted card, the way the desktop sits below a
 *  window. `delay` staggers the spawn after the bar itself springs in. */
export function Bracket({
  label,
  delay = 0,
  className,
  children,
}: {
  label: string
  delay?: number
  className?: string
  children: ReactNode
}) {
  return (
    <m.div
      role="group"
      aria-label={label}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...BRACKET_SPRING, delay }}
      className={cn("flex h-10 shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background/50 p-1", className)}
    >
      {children}
    </m.div>
  )
}

/** Hairline between modules inside a bracket. Below sm every item is an icon
 *  alone, so the hairlines go and the icons sit tight. */
export function DockDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-0.5 h-3.5 w-px shrink-0 bg-border max-sm:hidden", className)} />
}

const ICON_SPRING: Transition = { type: "spring", stiffness: 480, damping: 32 }

/** Cross-fades between stacked icons inside a fixed-size (relative) button —
 *  unlike a keyed remount, the outgoing icon animates away too. */
export function IconStack<K extends string>({
  active,
  icons,
  className,
}: {
  active: K
  icons: Record<K, LucideIcon>
  className?: string
}) {
  return (
    <>
      {(Object.entries(icons) as [K, LucideIcon][]).map(([key, Icon]) => (
        <m.span
          key={key}
          className={cn("absolute inset-0 grid place-items-center", className)}
          initial={false}
          animate={active === key ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
          transition={ICON_SPRING}
        >
          <Icon aria-hidden />
        </m.span>
      ))}
    </>
  )
}
