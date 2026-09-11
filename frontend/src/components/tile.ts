/** The frame both window tiles sit in — settings, and the reader: the full
 *  viewport, a hair of gap at the top and sides, and at the bottom the dock's
 *  height (published by Dock.tsx as --dock-h) plus a matching gap. A tile fills
 *  it with h-full and scrolls its own content; the page itself never scrolls.
 *  One string so the two frames cannot drift apart by a pixel. */
export const TILE_FRAME =
  "h-dvh w-full px-2 pt-2 pb-[calc(var(--dock-h)+0.5rem)] sm:px-3 sm:pt-3 sm:pb-[calc(var(--dock-h)+0.75rem)]"
