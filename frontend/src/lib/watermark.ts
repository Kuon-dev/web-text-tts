/** Anti-theft watermark detection for pasted chapters.
 *
 * Translation sites inject lines like "Stop stealing from me and create your
 * own stuff. Visit: https://…" into their chapters (and aggregators inject
 * their own), which the TTS then dutifully reads aloud. A sentence counts as
 * a watermark when it links out — light-novel prose never does — or when it
 * uses anti-theft / translator-note phrasing. Filtering is per sentence
 * inside each line so mid-paragraph injections vanish without taking the
 * surrounding story text with them.
 */

export interface StripResult {
  text: string
  removed: string[]
}

const SCHEME_RE = /https?:\/\/\S+|\bwww\.\S+/i

// Bare domains ("fanstranslations.com") on TLDs that aren't English words.
// Lowercase-only on purpose: missing-space scrape typos ("He stopped.Together
// they…") capitalize the next word and must not look like domains.
const SAFE_DOMAIN_RE =
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|net|org|info|biz|xyz|icu|moe|pw|cc|io|gg)\b/

// Word-like TLDs ("novelbin.top", "readnovel.live") collide with lowercase
// prose typos, so they only count alongside promotional context.
const RISKY_DOMAIN_RE =
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:top|site|online|blog|club|shop|space|fun|live|me|co|vip|life|world|today|store|website|stream|app|page|link|tv)\b/
const CONTEXT_RE = /\b(?:read|visit|chapters?|novels?|updated?|translat\w*|released?|free|latest|source)\b/i

// Anti-theft phrasing that needs no URL. Imperatives are anchored to the
// sentence start ("Stop stealing…") because mid-sentence occurrences are
// usually narration ("she wanted him to stop stealing").
const PHRASE_RES = [
  /^\W*(?:stop|don'?t|do not) steal(?:ing)?\b/i,
  /\bcreate your own stuff\b/i,
  /\bthis (?:content|chapter|translation|novel|story) (?:is|was|has been) (?:stolen|taken|copied|ripped|posted)\b/i,
  /\bif you(?:'re| are) (?:reading|seeing) this (?:on|at|from|anywhere)\b/i,
  /\btranslat(?:ion|ions|or|ors)\b[^.!?\n]{0,40}\b(?:hosted|posted|available|belongs?|property|exclusive)\b/i,
  /\bplease (?:read|support)\b[^.!?\n]{0,40}\b(?:translat\w+|official|original)\b/i,
  /\bsupport (?:the|our|your|this) translat\w+\b/i,
  /\bjoin (?:us|our|my|the)\b[^.!?\n]{0,24}\bdiscord\b/i,
  /\b(?:patreon|ko-?fi)\b/i,
  /\b(?:aggregator|pirate) ?sites?\b/i,
  /\bnovel ?updates\b/i,
  /\bread (?:the )?(?:official|original|latest) (?:version|release|translation|chapters?)\b/i,
  /\bunauthorized (?:copy|copies|reproduction|reposting|use)\b/i,
]

// Sentences inside quotation marks are story dialogue — a character may well
// yell "Stop stealing from me!". Phrase detection skips them; URLs still count.
const QUOTED_RE = /["“”「」『』«»]/

function isWatermark(s: string): boolean {
  if (SCHEME_RE.test(s) || SAFE_DOMAIN_RE.test(s)) return true
  if (!QUOTED_RE.test(s) && PHRASE_RES.some((re) => re.test(s))) return true
  return RISKY_DOMAIN_RE.test(s) && CONTEXT_RE.test(s)
}

/** Sentence boundaries: after .!?… plus any closing quotes/brackets, before whitespace. */
const SENTENCE_SPLIT = /(?<=[.!?…][)\]"'”’»」』]*)(?=\s)/

export function stripWatermarks(text: string): StripResult {
  const removed: string[] = []

  // A line maps to itself (clean), a shorter join (partly filtered), or
  // null (the whole line was watermark).
  const filterLine = (line: string): string | null => {
    if (!line.trim()) return line
    const parts = line.split(SENTENCE_SPLIT)
    const kept: string[] = []
    let droppedFirst = false
    for (let i = 0; i < parts.length; i++) {
      if (isWatermark(parts[i])) {
        removed.push(parts[i].trim())
        if (i === 0) droppedFirst = true
      } else {
        kept.push(parts[i])
      }
    }
    if (kept.length === parts.length) return line
    const joined = kept.join("")
    if (!joined.trim()) return null
    return droppedFirst ? joined.trimStart() : joined
  }

  const lines = text.split("\n").map(filterLine)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === null) {
      // Whole line removed: swallow one adjacent blank line so the removal
      // doesn't leave a doubled paragraph gap.
      const prevBlank = out.length === 0 || out[out.length - 1].trim() === ""
      const next = lines[i + 1]
      if (prevBlank && typeof next === "string" && next.trim() === "") i++
      continue
    }
    out.push(line)
  }
  return { text: out.join("\n"), removed }
}
