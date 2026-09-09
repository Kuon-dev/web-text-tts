/** Convert a rich-HTML clipboard fragment into chapter text, extracting the
 *  images it references. Each image becomes a `@@IMG<n>@@` placeholder line;
 *  the paste dialog swaps placeholders for `[img:<id>]` markers once the
 *  server has imported each image. */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "IFRAME", "SVG", "BUTTON", "NAV"])

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL",
])

export interface HtmlChapter {
  text: string
  urls: string[]
}

export const imgPlaceholder = (n: number) => `@@IMG${n}@@`

// `![alt](src)`, `![alt](<src>)`, `![alt](src "title")`. The plain link form
// `[text](src)` is not an image and is left as prose.
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s<>]+)>?(?:\s+"[^"]*")?\s*\)/g

/** Chapter pasted as markdown: pull `![alt](src)` out into image placeholders.
 *
 *  Each image is lifted onto a line of its own — the reader only recognises an
 *  illustration when its `[img:…]` marker is the whole paragraph — and the text
 *  is normalised to one blank line per break, matching htmlChapter. Text with
 *  no images is returned untouched so an ordinary paste keeps its formatting. */
export function markdownChapter(text: string): HtmlChapter {
  const urls: string[] = []
  const staged = text.replace(MD_IMAGE_RE, (_m, src: string) => {
    urls.push(src)
    return `\n${imgPlaceholder(urls.length - 1)}\n`
  })
  if (!urls.length) return { text, urls }
  const out = staged
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n")
  return { text: out, urls }
}

export function htmlChapter(html: string): HtmlChapter {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const urls: string[] = []
  const out: string[] = []

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Newlines inside HTML text nodes are source pretty-printing, not
      // breaks — browsers collapse them to spaces, so do the same. Only
      // BR and block tags below may emit "\n".
      out.push((node.nodeValue ?? "").replace(/\s+/g, " "))
      return
    }
    if (!(node instanceof Element)) return
    const tag = node.tagName
    if (SKIP_TAGS.has(tag)) return
    if (tag === "IMG") {
      const src = node.getAttribute("src") ?? ""
      if (src) {
        out.push(`\n${imgPlaceholder(urls.length)}\n`)
        urls.push(src)
      }
      return
    }
    if (tag === "BR") {
      out.push("\n")
      return
    }
    const block = BLOCK_TAGS.has(tag)
    if (block) out.push("\n")
    node.childNodes.forEach(walk)
    if (block) out.push("\n")
  }
  walk(doc.body)

  const text = out
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
  return { text, urls }
}
