import type { FontKey, ReadingPrefs } from "@/lib/reading"
import { SECTION_DEFAULTS } from "@/lib/settings"
import { FontPicker } from "./FontPicker"
import { NumberField, SectionHeader, SettingRow, SwitchRow } from "./controls"

interface Props {
  prefs: ReadingPrefs
  update: (patch: Partial<ReadingPrefs>) => void
  onHoverFont: (f: FontKey | null) => void
}

export function ReadingSection({ prefs, update, onHoverFont }: Props) {
  return (
    <>
      <SectionHeader title="Reading" description="How chapter text is set. The preview follows every change." onReset={() => update(SECTION_DEFAULTS.reading)} />
      <SettingRow label="Font">
        <FontPicker value={prefs.font} onChange={(font) => update({ font })} onHover={onHoverFont} />
      </SettingRow>
      <NumberField label="Size" value={prefs.size} min={14} max={26} step={1} unit="px" onChange={(size) => update({ size })} />
      <NumberField label="Line spacing" value={prefs.lineHeight} min={1.3} max={2.4} step={0.05} onChange={(lineHeight) => update({ lineHeight })} />
      <NumberField label="Paragraph spacing" value={prefs.paraSpacing} min={0.4} max={2.4} step={0.1} unit="em" onChange={(paraSpacing) => update({ paraSpacing })} />
      <NumberField
        label="Text width"
        description="How wide the column may grow. The preview caption shows it in pixels."
        value={prefs.width}
        min={34}
        max={60}
        step={1}
        onChange={(width) => update({ width })}
      />
      <SwitchRow id="pref-justify" label="Justify text" description="Straight right edge, like a printed book." checked={prefs.justify} onChange={(justify) => update({ justify })} />
      <SwitchRow id="pref-autoscroll" label="Auto-scroll" description="Keep the sentence being read in view." checked={prefs.autoScroll} onChange={(autoScroll) => update({ autoScroll })} />
    </>
  )
}
