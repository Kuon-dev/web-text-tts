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

export function htmlChapter(html: string): HtmlChapter {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const urls: string[] = []
  const out: string[] = []

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? "")
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
