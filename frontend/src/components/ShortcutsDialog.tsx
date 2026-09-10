import { useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ACTIONS, formatSpec, isMac, type Group } from "@/lib/keymap"

interface Row {
  id: string
  label: string
  keys: string[]
}

/** Escape is Radix's (dialogs, popovers) and `SettingsPage`'s own handler, so
 *  the registry deliberately leaves it out — a row there would mean two things
 *  racing for one key. The sheet still has to teach it, so it is appended as a
 *  static row rather than derived. */
const ESCAPE_ROW: Row = { id: "escape", label: "Close dialog or settings", keys: ["Esc"] }

/** Rows grouped by the action's own `Group`, in the order the registry declares
 *  them. Unlike the palette this keeps `palette: false` actions: the sheet
 *  documents what the keyboard does, not what the palette offers.
 *
 *  A paired action (←/→, ⇧↑/⇧↓, [/]) absorbs its partner into one row carrying
 *  both keys, because the pair is one idea — the registry has to split them
 *  since `run()` cannot tell which half fired, but the reader learns them
 *  together and two near-identical rows only make the sheet longer. */
function sheetGroups(mac: boolean): [Group, Row[]][] {
  const m = new Map<Group, Row[]>()
  const byId = new Map(ACTIONS.map((a) => [a.id, a]))
  const absorbed = new Set(ACTIONS.flatMap((a) => (a.pair ? [a.pair.with] : [])))
  for (const a of ACTIONS) {
    if (absorbed.has(a.id)) continue
    const partner = a.pair ? byId.get(a.pair.with) : undefined
    const row = {
      id: a.id,
      label: a.pair?.label ?? a.label,
      keys: [...a.keys, ...(partner?.keys ?? [])].map((k) => formatSpec(k, mac)),
    }
    m.set(a.group, [...(m.get(a.group) ?? []), row])
  }
  m.set("App", [...(m.get("App") ?? []), ESCAPE_ROW])
  return [...m.entries()]
}

/** The read-only shortcuts sheet, generated from the same registry that binds
 *  the keys — the reason there is a registry at all is that a hand-written list
 *  drifts the first time a binding moves. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const mac = useMemo(() => isMac(), [])
  const groups = useMemo(() => sheetGroups(mac), [mac])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            {/* Worth saying, because it is the one rule that is invisible: the
                single-key twins exist for browsers that swallow the combo, and
                they stand down while you are typing. */}
            {mac ? "⌘" : "Ctrl"} combos keep working while you type; their unmodified twins only work outside a
            text field.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {groups.map(([group, rows]) => (
            <section key={group}>
              <h3 className="pb-1 text-xs font-medium text-muted-foreground">{group}</h3>
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate">{r.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
