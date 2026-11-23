/**
 * How big a new reader is. It's sized to the part of the window the person can see, at a zoom text reads well at, so
 * when it's brought into view (fit, at most 100%) the whole of it shows without zooming out to small print. Pure, so
 * main and the tests share it.
 */

export interface Size {
  width: number
  height: number
}

/** The size when the window's size isn't known, as in tests: the reader's size before it was fitted. */
export const READER_DEFAULT: Size = { width: 780, height: 720 }
/** The reader's own smallest size (its Resizer's). */
export const READER_MIN: Size = { width: 420, height: 300 }
/** Wide enough for the outline, the page and the comments column side by side; no taller than a long read needs. */
export const READER_MAX: Size = { width: 1120, height: 900 }
/** The zooms a reader is read at. Below the first, text is small; above the second, it's the canvas's own size. */
export const READ_ZOOM = { min: 0.8, max: 1 }
/** Room left around it on screen, in pixels. */
const MARGIN = 32

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * The size for a new reader: what fits `area` (the visible canvas, in screen pixels) at the zoom it'll be read at,
 * which is the canvas's zoom brought into READ_ZOOM. Never smaller than READER_MIN or larger than READER_MAX.
 */
export function readerSize(area: Size | null | undefined, zoom: number): Size {
  if (!area || !(area.width > 0) || !(area.height > 0)) return READER_DEFAULT
  const z = clamp(zoom > 0 ? zoom : 1, READ_ZOOM.min, READ_ZOOM.max)
  return {
    width: Math.round(clamp((area.width - 2 * MARGIN) / z, READER_MIN.width, READER_MAX.width)),
    height: Math.round(clamp((area.height - 2 * MARGIN) / z, READER_MIN.height, READER_MAX.height))
  }
}

/** Below this width the comments column folds into the header's Comments button, so the page keeps its room. */
export const FOLD_COMMENTS_BELOW = 1100
/** At this width and above, the outline shows unless it's been closed. */
export const OUTLINE_FROM = 900

/**
 * Which side columns a reader shows. The person's own choice (true or false) wins; until they make one, the outline
 * shows on a wide reader, and the comments column shows while writing one, or when there are open comments and the
 * reader is wide enough to keep the page readable beside it.
 */
export function readerColumns(
  width: number,
  s: { outlineOpen: boolean | null; commentsOpen: boolean | null; openCount: number; drafting: boolean }
): { outline: boolean; comments: boolean } {
  return {
    outline: s.outlineOpen ?? width >= OUTLINE_FROM,
    comments: s.commentsOpen ?? (s.drafting || (s.openCount > 0 && width >= FOLD_COMMENTS_BELOW))
  }
}
