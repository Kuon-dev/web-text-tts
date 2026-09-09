import { describe, expect, it } from "vitest"
import { stripWatermarks } from "./watermark"

/** Assert the whole input survives untouched, and return it. */
function keeps(text: string): void {
  const { text: out, removed } = stripWatermarks(text)
  expect(removed).toEqual([])
  expect(out).toBe(text)
}

/** Assert every line of the input is recognised as a watermark. */
function drops(text: string): void {
  const { removed } = stripWatermarks(text)
  expect(removed).toEqual([text])
}

describe("stripWatermarks — anti-theft lines", () => {
  it("drops sentences carrying a link", () => {
    drops("Visit https://fanstranslations.com for the rest.")
    drops("Latest chapters at www.novelbin.net")
  })

  it("drops bare domains on non-word TLDs", () => {
    drops("fanstranslations.com")
    drops("Chapter continues on readnovel.io")
  })

  it("drops word-like TLDs only alongside promotional context", () => {
    drops("Read the rest at novelbin.top")
    keeps("The path ran along the ridge.")
  })

  it("drops the classic anti-theft imperatives", () => {
    drops("Stop stealing my content.")
    drops("Don't steal my translations.")
    drops("Stop stealing from me and create your own stuff.")
    // The sentence splitter cuts this pair apart, so each half must stand alone.
    drops("Stop stealing from me.")
    drops("Create your own stuff.")
  })

  it("drops if-you-are-reading-this warnings that name a site", () => {
    drops("If you're reading this on any other site, it was stolen.")
    drops("If you are reading this anywhere else, the translation was ripped.")
  })

  it("drops translator support pitches", () => {
    drops("Support the translator.")
    drops("Please support the translation on our page.")
    drops("Please read the official release instead.")
    drops("Read the latest chapters on our site.")
  })

  it("drops community and funding plugs", () => {
    drops("Join our Discord for early releases.")
    drops("Join us on discord for chapter polls.")
    drops("Early access on Patreon.")
    drops("Support me on ko-fi.")
  })

  it("drops ownership and aggregator notices", () => {
    drops("This chapter has been stolen.")
    drops("Unauthorized reposting is prohibited.")
    drops("Do not repost to aggregator sites.")
    drops("Rate this on novelupdates.")
  })
})

describe("stripWatermarks — ordinary prose is not a watermark", () => {
  it("keeps narrated theft that is not about content", () => {
    keeps("Stop stealing glances at me, she thought.")
    keeps("Don't steal the last bun, he warned.")
  })

  it("keeps a letter addressed to its reader", () => {
    keeps("If you are reading this, I am already dead.")
    keeps("If you're reading this from the tower, look to the west.")
  })

  it("keeps translation as a subject of the story", () => {
    keeps("Support the translation of the ancient tablet, the priest urged.")
    keeps("She read the original version of the manuscript twice.")
  })

  it("keeps official documents that are not chapter releases", () => {
    keeps("Please read the official report before the council convenes.")
  })

  it("keeps discord in its older sense", () => {
    keeps("Join us in the discord of battle and let steel decide.")
  })

  it("keeps unauthorized acts that are not reposting", () => {
    keeps("The unauthorized use of the royal seal was a capital offence.")
  })

  it("keeps names that merely look like funding sites", () => {
    keeps("Kofi handed him the map without a word.")
  })

  it("keeps anti-theft phrasing spoken by a character", () => {
    keeps('"Stop stealing my work!" she yelled at the apprentice.')
    keeps("「Stop stealing my content」the merchant snapped.")
  })
})

describe("stripWatermarks — line and sentence handling", () => {
  it("filters per sentence, keeping the surrounding prose", () => {
    const { text, removed } = stripWatermarks("He drew his sword. Read more at novelbin.top. Then he ran.")
    expect(removed).toEqual(["Read more at novelbin.top."])
    expect(text).toBe("He drew his sword. Then he ran.")
  })

  it("trims the gap left by a dropped leading sentence", () => {
    const { text } = stripWatermarks("Visit https://x.com now. He drew his sword.")
    expect(text).toBe("He drew his sword.")
  })

  it("swallows one blank line when a whole paragraph goes", () => {
    const { text } = stripWatermarks("Prose one.\n\nRead the rest at novelbin.top\n\nProse two.")
    expect(text).toBe("Prose one.\n\nProse two.")
  })

  it("reports every removed sentence", () => {
    const { removed } = stripWatermarks("Visit https://a.com\n\nHe ran. Support the translator.")
    expect(removed).toEqual(["Visit https://a.com", "Support the translator."])
  })

  it("leaves clean text byte-identical", () => {
    keeps("Prose one.\n\nProse two.\n\nProse three.")
  })
})

describe("stripWatermarks — markdown illustrations", () => {
  const SRC = `http://localhost:8787/image/${"5f".repeat(20)}`

  it("never treats a markdown image as a watermark, despite its URL", () => {
    keeps(`![Illustration 1](${SRC})`)
    keeps("![](https://example.com/pic.png)")
  })

  it("keeps markdown images interleaved with prose", () => {
    keeps(`He opened the door.\n\n![Illustration 1](${SRC})\n\nShe was waiting.`)
  })

  it("keeps prose that carries an inline markdown image", () => {
    keeps(`He turned. ![Illustration 2](${SRC}) She waited.`)
  })

  it("keeps every image when a real watermark sits between them", () => {
    const { text, removed } = stripWatermarks(
      `![Illustration 1](${SRC})\n\nRead the rest at novelbin.top\n\n![Illustration 2](${SRC})`,
    )
    expect(removed).toEqual(["Read the rest at novelbin.top"])
    expect(text).toBe(`![Illustration 1](${SRC})\n\n![Illustration 2](${SRC})`)
  })

  it("still drops a plain markdown link, which is not an illustration", () => {
    drops("[Read more chapters](https://novelbin.com/latest)")
  })
})

describe("stripWatermarks — illustration markers", () => {
  const ID = "a".repeat(40)
  const ID2 = "3f".repeat(20)

  it("never treats an [img:…] marker as a watermark", () => {
    keeps(`Prose one.\n\n[img:${ID}]\n\nProse two.`)
  })

  it("keeps markers when the paragraphs around them are watermarks", () => {
    const { text } = stripWatermarks(`[img:${ID}]\n\nRead the rest at novelbin.top\n\n[img:${ID2}]`)
    expect(text).toBe(`[img:${ID}]\n\n[img:${ID2}]`)
  })
})
