import { useEffect, useMemo, useState } from "react"
import type { KeyboardEvent } from "react"
import { toast } from "sonner"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ENGINE_TOAST, useEngineCatalog } from "@/components/EngineModePicker"
import { useVoiceGroups } from "@/components/VoiceCombobox"
import { voiceLabel } from "@/lib/api"
import { ACTIONS, formatSpec, isMac, type Action, type Group, type KeymapCtx } from "@/lib/keymap"
import { player, usePlayer } from "@/lib/player"

/** The lists that are too long to live as palette rows: they get a page of
 *  their own, reached by a root row or straight from `v` / `e` / `⇧B`. */
export type PalettePage = "voice" | "model" | "bookmarks"

// Built once at module scope: ACTIONS is frozen data, and the group order that
// falls out of first appearance is the order the registry declares — the only
// place that ordering should be spelled out.
const ROOT_GROUPS: [Group, Action[]][] = (() => {
  const m = new Map<Group, Action[]>()
  for (const a of ACTIONS) {
    if (a.palette === false) continue
    m.set(a.group, [...(m.get(a.group) ?? []), a])
  }
  return [...m.entries()]
})()

const PLACEHOLDER: Record<string, string> = {
  voice: "Search voices…",
  model: "Search models…",
  bookmarks: "Search bookmarks…",
  root: "Type a command…",
}

const EMPTY: Record<string, string> = {
  voice: "No voice found.",
  model: "No model found.",
  bookmarks: "No bookmarks yet — press b to mark the sentence being read.",
  root: "No command found.",
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Page to land on. `v` and `e` open the palette straight onto a list, so the
   *  opener — not the palette — decides where an open starts. */
  initialPage?: PalettePage | null
  /** The dispatcher's context, so a root row runs exactly the same code path as
   *  the key that binds it. */
  ctx: KeymapCtx
}

/** Everything the keymap can do, searchable, plus the two lists that are too
 *  long to bind to keys. Composed out of `Dialog` + `Command` rather than the
 *  `CommandDialog` wrapper because the sub-pages need `onEscapeKeyDown`:
 *  Radix listens for Escape on the document in the capture phase, so a nested
 *  handler can never pop a page before the dialog dismisses itself, and
 *  `CommandDialog` forwards its props to `Dialog` (the root), not to the
 *  content that accepts that callback. */
export function CommandPalette({ open, onOpenChange, initialPage = null, ctx }: Props) {
  const [page, setPage] = useState<PalettePage | null>(initialPage)
  const [search, setSearch] = useState("")
  const { voice, voices, engine, switchingTo, bookmarks } = usePlayer()
  const voiceGroups = useVoiceGroups(voices)
  const engines = useEngineCatalog()
  const mac = useMemo(() => isMac(), [])

  // Every open honours the requested page, and a re-request while open (typing
  // `v` at the root) navigates — otherwise the second press of a page key would
  // look dead, since the dialog is already open.
  useEffect(() => {
    if (!open) return
    setPage(initialPage)
    setSearch("")
  }, [open, initialPage])

  /** Navigating always drops the query: the text that found "Voice…" is never
   *  the text that finds a voice. */
  const goto = (p: PalettePage | null) => {
    setPage(p)
    setSearch("")
  }

  /** A row that opens a sub-page must leave the dialog up, and the registry
   *  expresses "open a page" as a call on the ctx rather than as an id this
   *  component could special-case. So the action runs against a ctx whose
   *  navigation entries are rebound to this palette's own page state, and only
   *  an action that navigated nowhere dismisses the palette. */
  const runAction = (action: Action) => {
    let navigated = false
    action.run({
      ...ctx,
      openPalette: () => {
        navigated = true
        goto(null)
      },
      openPalettePage: (p) => {
        navigated = true
        goto(p)
      },
    })
    if (!navigated) onOpenChange(false)
  }

  const selectVoice = async (id: string) => {
    onOpenChange(false)
    if (id !== voice && !(await player.setVoice(id))) {
      toast.error("Voice change failed — is the server running?")
    }
  }

  /** A bookmark is a place to read from, so going to one moves the playhead —
   *  the same thing clicking a sentence does. */
  const selectBookmark = (chunk: number) => {
    onOpenChange(false)
    player.jump(chunk)
  }

  const selectEngine = async (id: string) => {
    onOpenChange(false)
    // A switch in flight waits on EngineManager's lock behind the chunk being
    // spoken; setEngine would refuse a second one anyway, and refusing here
    // keeps the palette from reporting a failure that never happened.
    if (id === engine?.engine || switchingTo !== null) return
    try {
      await player.setEngine(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Engine switch failed — is the server running?", { id: ENGINE_TOAST })
    }
  }

  // Backspace in an empty input is the way back out of a page — the same
  // gesture that would delete the query character the user no longer has.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Backspace" && page !== null && search === "") {
      e.preventDefault()
      goto(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-md"
        onEscapeKeyDown={(e) => {
          if (page === null) return
          e.preventDefault()
          goto(null)
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search every command, voice and model.</DialogDescription>
        </DialogHeader>
        <Command onKeyDown={onKeyDown}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={PLACEHOLDER[page ?? "root"]}
          />
          <CommandList>
            <CommandEmpty>{EMPTY[page ?? "root"]}</CommandEmpty>

            {page === null &&
              ROOT_GROUPS.map(([group, actions]) => (
                <CommandGroup key={group} heading={group}>
                  {actions.map((a) => (
                    <CommandItem key={a.id} value={`${a.label} ${a.id}`} onSelect={() => runAction(a)}>
                      <span className="min-w-0 flex-1 truncate">{a.label}</span>
                      {/* The headline binding only: the sheet is where aliases are taught. */}
                      {a.keys[0] && <CommandShortcut>{formatSpec(a.keys[0], mac)}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}

            {page === "voice" &&
              voiceGroups.map(([group, vs]) => (
                <CommandGroup key={group} heading={group}>
                  {vs.map((v) => (
                    <CommandItem
                      key={v.id}
                      value={`${voiceLabel(v)} ${v.id}`}
                      data-checked={v.id === voice}
                      onSelect={() => void selectVoice(v.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}

            {page === "model" && (
              <CommandGroup heading="Model">
                {engines.map((e) => (
                  <CommandItem
                    key={e.id}
                    value={`${e.label} ${e.id}`}
                    disabled={!e.available}
                    data-checked={e.id === engine?.engine}
                    onSelect={() => void selectEngine(e.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    {/* An engine the machine cannot run stays listed, with the
                        server's reason, so its absence is never a mystery. */}
                    {!e.available && e.reason && <span className="truncate text-xs text-muted-foreground">{e.reason}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {page === "bookmarks" && (
              <CommandGroup heading="Bookmarks">
                {bookmarks.map((m) => (
                  <CommandItem
                    key={m.chunk}
                    value={`${m.excerpt} ${m.chunk}`}
                    onSelect={() => selectBookmark(m.chunk)}
                  >
                    <span className="min-w-0 flex-1 truncate">{m.excerpt}</span>
                    {/* Sentence number, 1-based like the dock's counter. */}
                    <CommandShortcut>{m.chunk + 1}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
