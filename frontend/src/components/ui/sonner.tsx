import type { CSSProperties } from "react"
import { CircleCheck, Info, Loader2, OctagonX, TriangleAlert } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/** shadcn's Sonner wrapper, minus next-themes: `theme` comes from the caller
 *  (src/lib/theme.ts decides light/dark), and the colours come from the active
 *  scheme's popover tokens so a toast under Catppuccin looks like Catppuccin. */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
