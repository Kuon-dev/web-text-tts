import { describe, expect, it } from "vitest"
import { wallpaperFitStyle } from "./wallpaper"

describe("wallpaperFitStyle", () => {
  it("maps the relative fits straight to background-size", () => {
    expect(wallpaperFitStyle("cover")).toEqual({ backgroundSize: "cover", backgroundRepeat: "no-repeat" })
    expect(wallpaperFitStyle("contain")).toEqual({ backgroundSize: "contain", backgroundRepeat: "no-repeat" })
    expect(wallpaperFitStyle("stretch")).toEqual({ backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" })
  })

  it("uses the image's natural size for tile and center at full scale", () => {
    expect(wallpaperFitStyle("tile")).toEqual({ backgroundSize: "auto", backgroundRepeat: "repeat" })
    expect(wallpaperFitStyle("center")).toEqual({ backgroundSize: "auto", backgroundRepeat: "no-repeat" })
  })

  it("scales the natural size for a miniature", () => {
    const scale = { w: 1920, h: 1080, ratio: 0.25 }
    expect(wallpaperFitStyle("tile", scale)).toEqual({ backgroundSize: "480px 270px", backgroundRepeat: "repeat" })
    expect(wallpaperFitStyle("center", scale)).toEqual({ backgroundSize: "480px 270px", backgroundRepeat: "no-repeat" })
    // relative fits ignore the scale
    expect(wallpaperFitStyle("cover", scale)).toEqual({ backgroundSize: "cover", backgroundRepeat: "no-repeat" })
  })

  it("never collapses a scaled image below 1px", () => {
    expect(wallpaperFitStyle("tile", { w: 10, h: 10, ratio: 0.01 })).toEqual({ backgroundSize: "1px 1px", backgroundRepeat: "repeat" })
  })
})
