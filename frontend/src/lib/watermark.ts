/** Anti-theft watermark detection for pasted chapters.
 *
 * Translation sites inject lines like "Stop stealing from me and create your
 * own stuff. Visit: https://…" into their chapters (and aggregators inject
 * their own), which the TTS then dutifully reads aloud. A sentence counts as
 * a watermark when it links out — light-novel prose never does — or when it
 * uses anti-theft / translator-note phrasing. Filtering is per sentence
 * inside each line so mid-paragraph injections vanish without taking the
 * surrounding story text with them.
 *
 * The one link that is never a watermark is a markdown image — that is an
 * illustration, and its URL must not condemn the paragraph carrying it.
 */

export interface StripResult {
  text: string
  removed: string[]
}

const SCHEME_RE = /https?:\/\/\S+|\bwww\.\S+/i

// `![alt](src)` — an illustration pasted as markdown. Blanked out before any
// rule runs, so the image's own URL can never flag its paragraph, while a
// watermark sharing that paragraph is still caught on what remains. The plain
// link form `[text](src)` is deliberately NOT exempt: that one is watermark-
// shaped ("[Read more](https://…)").
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g

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

// What a watermark is *about*: the stolen thing. Every phrase rule below that
// could otherwise fire on narration ("stop stealing glances", "support the
// translation of the tablet") requires one of these nearby, so the rule keys
// on published content rather than on a verb the story also uses.
const WORK_RE =
  /\b(?:content|chapters?|translat(?:ion|ions|or|ors)|novels?|stor(?:y|ies)|works?|stuff|texts?|posts?|sites?|websites?|releases?)\b/

// Anti-theft phrasing that needs no URL. Imperatives are anchored to the
// sentence start ("Stop stealing…") because mid-sentence occurrences are
// usually narration ("she wanted him to stop stealing").
const PHRASE_RES = [
  // "Stop stealing my content" / "Stop stealing from me", but not "Stop
  // stealing glances at me" — the object has to be the work or its author.
  new RegExp(
    `^\\W*(?:stop|don'?t|do not) steal(?:ing)?\\b(?:\\s+from (?:me|us)\\b|[^.!?\\n]{0,40}${WORK_RE.source})`,
    "i",
  ),
  /\bcreate your own stuff\b/i,
  /\bthis (?:content|chapter|translation|novel|story) (?:is|was|has been) (?:stolen|taken|copied|ripped|posted)\b/i,
  // "If you're reading this on any other site" — but not the letter-to-the-
  // reader that light novels are fond of ("If you are reading this, I am dead").
  /\bif you(?:'re| are) (?:reading|seeing) this\b[^.!?\n]{0,50}\b(?:sites?|web ?sites?|web ?pages?|apps?|aggregator|other than|elsewhere|anywhere else)\b/i,
  /\btranslat(?:ion|ions|or|ors)\b[^.!?\n]{0,40}\b(?:hosted|posted|available|belongs?|property|exclusive)\b/i,
  // "Please read the official release", not "please read the official report".
  /\bplease (?:read|support)\b[^.!?\n]{0,40}\b(?:translat\w+|(?:official|original) (?:version|release|source|page|site|website|chapters?|novels?))\b/i,
  // "Support the translator", not "Support the translation of the tablet".
  /\bsupport (?:the|our|your|this) translat(?:ion|ions|or|ors)\b(?!\s+of\b)/i,
  // Discord the service, not discord the strife ("the discord of battle").
  /\bjoin (?:us|our|my|the)\b[^.!?\n]{0,24}\bdiscord\b(?!\s+(?:of|among|amongst|between|and)\b)/i,
  // "kofi" unhyphenated is a given name, so only ko-fi proper counts.
  /\bpatreon\b|\bko-fi\b/i,
  /\b(?:aggregator|pirate) ?sites?\b/i,
  /\bnovel ?updates\b/i,
  // Imperative only: "She read the original version of the manuscript" is prose.
  /^\W*read (?:the )?(?:official|original|latest) (?:version|release|translation|chapters?)\b/i,
  // "Unauthorized use" alone is ordinary plot material (of a seal, of magic).
  /\bunauthorized (?:cop(?:y|ies|ying)|reproduction|reposting|distribution)\b/i,
]

// Sentences inside quotation marks are story dialogue — a character may well
// yell "Stop stealing from me!". Phrase detection skips them; URLs still count.
const QUOTED_RE = /["“”「」『』«»]/

function isWatermark(sentence: string): boolean {
  const s = sentence.replace(MD_IMAGE_RE, " ")
  if (!s.trim()) return false // the sentence was nothing but illustrations
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
