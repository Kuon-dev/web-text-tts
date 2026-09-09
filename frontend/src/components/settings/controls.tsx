import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { Minus, Plus, RotateCcw, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { formatValue, rovingNext, stepValue } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { useFileDrop } from "./useFileDrop"

export function SectionHeader({ title, description, onReset }: { title: string; description: string; onReset?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {onReset && (
        <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" onClick={onReset}>
          <RotateCcw aria-hidden />
          Reset
        </Button>
      )}
    </div>
  )
}

/** Label + optional description, with the control inline on the right
 *  (`inline`, for switches and segments) or below at full width. */
export function SettingRow({
  label,
  description,
  htmlFor,
  inline,
  children,
}: {
  label: string
  description?: string
  htmlFor?: string
  inline?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn(inline ? "flex items-center justify-between gap-6" : "space-y-2.5")}>
      <div className="space-y-1">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </Label>
        ) : (
          <span className="block text-sm leading-none font-medium select-none">{label}</span>
        )}
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

export function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <SettingRow label={label} description={description} htmlFor={id} inline>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  )
}

/** Joined radio group: arrow keys move the selection, one roving tab stop. */
export function Segmented<K extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: K
  options: { key: K; label: string; Icon?: LucideIcon }[]
  onChange: (k: K) => void
  className?: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = rovingNext(options.map((o) => o.key), value, e.key)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex w-full flex-wrap gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      {options.map(({ key, label: text, Icon }) => {
        const active = key === value
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            data-key={key}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[min(var(--radius-md),12px)] px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-3.5" aria-hidden />}
            {text}
          </button>
        )
      })}
    </div>
  )
}

/** Label, `[−] value [+]` stepper on the right, slider underneath. Works in
 *  display units — callers convert (e.g. uiScale 1.0 ↔ 100). */
export function NumberField({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
}) {
  const bump = (dir: 1 | -1) => onChange(stepValue(value, step, dir, min, max))
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <span className="text-sm font-medium">{label}</span>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" onClick={() => bump(-1)} disabled={value <= min} aria-label={`Decrease ${label}`}>
            <Minus aria-hidden />
          </Button>
          <span className="min-w-14 text-center font-mono text-xs tabular-nums">
            {formatValue(value, step)}
            {unit ? ` ${unit}` : ""}
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => bump(1)} disabled={value >= max} aria-label={`Increase ${label}`}>
            <Plus aria-hidden />
          </Button>
        </div>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} aria-label={label} />
    </div>
  )
}

/** Dashed click-or-drop target wrapping a hidden file input. */
export function DropZone({
  Icon,
  label,
  hint,
  accept,
  onFile,
  className,
}: {
  Icon: LucideIcon
  label: string
  hint: string
  accept: string
  onFile: (f: File) => void
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { dragging, dropProps } = useFileDrop(onFile)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) onFile(f)
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        data-dragging={dragging || undefined}
        {...dropProps}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50 data-dragging:border-ring data-dragging:bg-accent",
          className,
        )}
      >
        <Icon className="size-5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>
    </>
  )
}
