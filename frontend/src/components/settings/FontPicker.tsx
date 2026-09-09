import { useState, type KeyboardEvent } from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FONT_HINTS, FONT_LABELS, FONT_STACKS, type FontKey } from "@/lib/reading"
import { FONT_FILTERS, filterFonts, rovingNext } from "@/lib/settings"
import { cn } from "@/lib/utils"

interface Props {
  value: FontKey
  onChange: (f: FontKey) => void
  /** Pointer or keyboard focus on a row previews it; null clears. */
  onHover: (f: FontKey | null) => void
}

/** Chip-filtered list of the reading fonts, each row set in its own face.
 *  A radiogroup: arrow keys move (and commit) the selection. */
export function FontPicker({ value, onChange, onHover }: Props) {
  const [filter, setFilter] = useState("All")
  const groups = filterFonts(filter)
  const visible = groups.flatMap((g) => g.fonts)
  // One roving tab stop: the selected font when it is visible, else the first row.
  const tabStop = visible.includes(value) ? value : visible[0]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingNext(visible, value, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-font="${next}"]`)?.focus()
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Font category">
        {FONT_FILTERS.map((f) => (
          <Button key={f} variant={filter === f ? "secondary" : "ghost"} size="xs" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </Button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label="Reading font"
        onKeyDown={onKeyDown}
        onPointerLeave={() => onHover(null)}
        className="overflow-hidden rounded-md border"
      >
        {groups.map(({ label, fonts }) => (
          <div key={label}>
            {filter === "All" && (
              <div className="px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
            )}
            {fonts.map((k) => {
              const selected = k === value
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-font={k}
                  tabIndex={k === tabStop ? 0 : -1}
                  onClick={() => onChange(k)}
                  onPointerEnter={() => onHover(k)}
                  onFocus={() => onHover(k)}
                  onBlur={() => onHover(null)}
                  className={cn(
                    "flex w-full cursor-pointer items-baseline justify-between gap-4 px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent",
                    selected && "bg-secondary",
                  )}
                >
                  <span className="text-[17px] leading-6" style={{ fontFamily: FONT_STACKS[k] }}>
                    {FONT_LABELS[k]}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {FONT_HINTS[k]}
                    <Check className={cn("size-3.5", selected ? "text-foreground" : "invisible")} aria-hidden />
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
