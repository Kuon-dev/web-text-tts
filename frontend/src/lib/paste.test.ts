import { describe, expect, it } from "vitest"
import { imgPlaceholder, markdownChapter } from "./paste"

const P = (n: number) => imgPlaceholder(n)

describe("markdownChapter", () => {
  it("leaves text without images completely alone", () => {
    const text = "He opened the door.\n\nShe was waiting.\n"
    expect(markdownChapter(text)).toEqual({ text, urls: [] })
  })

  it("lifts a markdown image out into a placeholder", () => {
    const { text, urls } = markdownChapter("Before.\n\n![Illustration 1](http://localhost:8787/image/abc)\n\nAfter.")
    expect(urls).toEqual(["http://localhost:8787/image/abc"])
    expect(text).toBe(`Before.\n\n${P(0)}\n\nAfter.`)
  })

  it("numbers placeholders in source order", () => {
    const { text, urls } = markdownChapter("![a](u1)\n\n![b](u2)\n\n![c](u3)")
    expect(urls).toEqual(["u1", "u2", "u3"])
    expect(text).toBe(`${P(0)}\n\n${P(1)}\n\n${P(2)}`)
  })

  it("puts an inline image on its own line, so its marker stands alone", () => {
    const { text, urls } = markdownChapter("He turned. ![x](u) She waited.")
    expect(urls).toEqual(["u"])
    expect(text).toBe(`He turned.\n\n${P(0)}\n\nShe waited.`)
  })

  it("keeps only the src when a title is present", () => {
    expect(markdownChapter('![a](http://h/i.png "Chapter art")').urls).toEqual(["http://h/i.png"])
  })

  it("accepts the angle-bracket src form", () => {
    expect(markdownChapter("![a](<http://h/i.png>)").urls).toEqual(["http://h/i.png"])
  })

  it("ignores a plain markdown link, which is not an image", () => {
    const text = "See [the index](http://h/index) for more."
    expect(markdownChapter(text)).toEqual({ text, urls: [] })
  })

  it("collapses the blank runs an extracted image leaves behind", () => {
    const { text } = markdownChapter("Before.\n\n\n![a](u)\n\n\n\nAfter.")
    expect(text).toBe(`Before.\n\n${P(0)}\n\nAfter.`)
  })
})
