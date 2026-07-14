import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { FONT_LABELS, FONT_STACKS, type FontKey, type ReadingPrefs } from "@/lib/reading"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  reset: () => void
}

function PrefRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      {children}
    </div>
  )
}

export function ReadingMenu({ prefs, update, reset }: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title="Reading settings" aria-label="Reading settings">
          <span className="font-serif text-sm leading-none">Aa</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Font</Label>
            <Select value={prefs.font} onValueChange={(v) => update({ font: v as FontKey })}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FONT_LABELS) as FontKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    <span style={{ fontFamily: FONT_STACKS[k] }}>{FONT_LABELS[k]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <PrefRow label="Size" value={`${prefs.size}px`}>
            <Slider value={[prefs.size]} min={14} max={26} step={1} onValueChange={([v]) => update({ size: v })} />
          </PrefRow>
          <PrefRow label="Line spacing" value={prefs.lineHeight.toFixed(2)}>
            <Slider
              value={[prefs.lineHeight]}
              min={1.3}
              max={2.4}
              step={0.05}
              onValueChange={([v]) => update({ lineHeight: v })}
            />
          </PrefRow>
          <PrefRow label="Text width" value={`${prefs.width}`}>
            <Slider value={[prefs.width]} min={34} max={60} step={1} onValueChange={([v]) => update({ width: v })} />
          </PrefRow>
          <Separator />
          <Button variant="ghost" size="sm" className="w-full" onClick={reset}>
            Reset to defaults
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
