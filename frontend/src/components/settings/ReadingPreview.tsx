import { FONT_LABELS, FONT_STACKS, readerMaxWidth, type FontKey, type ReadingPrefs } from "@/lib/reading"

/** Two sample paragraphs set exactly as the reader would set them. While a
 *  font row is hovered or focused it shows that face instead of the saved one. */
export function ReadingPreview({ prefs, hoverFont }: { prefs: ReadingPrefs; hoverFont: FontKey | null }) {
  // A row only counts as a hover preview when it differs from the saved font;
  // the pointer (or focus) sits on the selected row most of the time.
  const hovered = hoverFont !== null && hoverFont !== prefs.font ? hoverFont : null
  const font = hovered ?? prefs.font
  const caption = hovered
    ? `${FONT_LABELS[hovered]} — click to use`
    : `${FONT_LABELS[prefs.font]} · ${prefs.size} px · ${prefs.lineHeight.toFixed(2)} · ≈ ${readerMaxWidth(prefs.width)} px column`

  return (
    <div className="space-y-2">
      <div
        aria-hidden
        className="relative max-h-40 overflow-hidden rounded-lg border bg-card/85 px-5 py-4 [mask-image:linear-gradient(to_bottom,black_65%,transparent)] md:max-h-64 xl:max-h-none xl:[mask-image:none]"
        style={{
          fontFamily: FONT_STACKS[font],
          fontSize: `${prefs.size}px`,
          lineHeight: prefs.lineHeight,
          textAlign: prefs.justify ? "justify" : undefined,
        }}
      >
        <p style={{ marginBottom: `${prefs.paraSpacing}em` }}>
          The rain had stopped by the time she reached the station, though the platform still shone under the lamps. She
          counted the carriages as they slid past — seven, eight — and only then let herself breathe.
        </p>
        <p>
          <span className="rd-chunk hl-current rounded-sm box-decoration-clone px-0.5">
            “You’re late,” said the man in the grey coat, not unkindly.
          </span>{" "}
          <em>So are you</em>, she thought, and said nothing.
        </p>
      </div>
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {caption}
      </p>
    </div>
  )
}
