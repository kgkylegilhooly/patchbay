import type { Rect, Size } from './place'

/**
 * The safe area: the part of the canvas no chrome covers (the sessions sidebar, the dock, the minimap, the link legend,
 * a panel on the right). Everything that puts something where the person can see it aims here: placement, fit view,
 * tidy, header zoom and "show this node". All boxes are in the canvas element's own pixels, from its top left.
 */

/** Room kept from the canvas's edges, and from each piece of chrome. Mirrored as --safe-margin and --safe-gap. */
export const SAFE_MARGIN = 16
export const SAFE_GAP = 12
/** Smaller than this either way and it isn't a usable area. */
const MIN_SIDE = 80

const right = (r: Rect): number => r.x + r.width
const bottom = (r: Rect): number => r.y + r.height
const area = (r: Rect): number => r.width * r.height
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)

/** The ways to keep `r` clear of `c`: everything right of it, left of it, below it or above it, if that's usable. */
function cutsAround(r: Rect, c: Rect): Rect[] {
  return [
    { x: right(c), y: r.y, width: right(r) - right(c), height: r.height },
    { x: r.x, y: r.y, width: c.x - r.x, height: r.height },
    { x: r.x, y: bottom(c), width: r.width, height: bottom(r) - bottom(c) },
    { x: r.x, y: r.y, width: r.width, height: c.y - r.y }
  ].filter((k) => k.width >= MIN_SIDE && k.height >= MIN_SIDE)
}

/** Past this many covers, each is cut the cheapest way in turn rather than every way being tried. */
const SEARCH_LIMIT = 7

/**
 * The largest rectangle of the stage that keeps clear of every cover, each cut off one side: a sidebar off the left, a
 * dock off the bottom, a legend off the top. Every choice of side is tried (there are only a few covers), so a corner
 * box such as the minimap goes whichever way loses least alongside the rest. A cover too big to cut around (a view
 * filling the canvas) is left out, so it never empties the area. Null for a stage too small.
 */
export function safeRect(stage: Size, covers: readonly Rect[], o: { margin?: number; gap?: number } = {}): Rect | null {
  const margin = o.margin ?? SAFE_MARGIN
  const gap = o.gap ?? SAFE_GAP
  const start: Rect = { x: margin, y: margin, width: stage.width - 2 * margin, height: stage.height - 2 * margin }
  if (!(start.width >= MIN_SIDE && start.height >= MIN_SIDE)) return null
  const padded = covers
    .filter((c) => c.width > 0 && c.height > 0)
    .map((c) => ({ x: c.x - gap, y: c.y - gap, width: c.width + 2 * gap, height: c.height + 2 * gap }))
    .sort((a, b) => area(b) - area(a))
  if (padded.length > SEARCH_LIMIT) {
    let r = start
    for (const c of padded) {
      const cuts = overlaps(r, c) ? cutsAround(r, c) : []
      if (cuts.length) r = cuts.reduce((best, k) => (area(k) > area(best) ? k : best))
    }
    return r
  }
  const best = (r: Rect, i: number): Rect => {
    if (i === padded.length) return r
    const cuts = overlaps(r, padded[i]) ? cutsAround(r, padded[i]) : []
    if (!cuts.length) return best(r, i + 1)
    return cuts.map((k) => best(k, i + 1)).reduce((a, b) => (area(b) > area(a) ? b : a))
  }
  return best(start, 0)
}

/** How far the safe area sits in from each side of the stage, as fit view's padding wants it. */
export function safeInsets(stage: Size, safe: Rect): { top: number; right: number; bottom: number; left: number } {
  return { top: safe.y, left: safe.x, right: Math.max(0, stage.width - right(safe)), bottom: Math.max(0, stage.height - bottom(safe)) }
}

/** React Flow's fitView padding for the safe area, plus `extra` pixels of air on each side. */
export type PxPadding = { top: `${number}px`; right: `${number}px`; bottom: `${number}px`; left: `${number}px` }

export function fitPadding(stage: Size, safe: Rect | null, extra = 0): PxPadding {
  const i = safe ? safeInsets(stage, safe) : { top: SAFE_MARGIN, right: SAFE_MARGIN, bottom: SAFE_MARGIN, left: SAFE_MARGIN }
  const px = (n: number): `${number}px` => `${Math.round(n + extra)}px`
  return { top: px(i.top), right: px(i.right), bottom: px(i.bottom), left: px(i.left) }
}

export interface DockInput {
  /** The stage's width. */
  stageWidth: number
  /** Where the free bottom row starts: the sidebar's right edge, or 0. */
  left: number
  /** Where it ends: a right-side panel's left edge, or the stage's width. */
  right: number
  /** The dock's own width, without the Map button. */
  dockWidth: number
  /** The minimap's width when it's on, in its corner; null when it's off. */
  mapWidth: number | null
  /** The Map button's width, added when the minimap folds into the dock. */
  mapButton?: number
}

/**
 * Where the dock goes on the bottom row: centred in the span between the sidebar and the right-hand chrome, moved left
 * as far as it takes to stay off the minimap. When the dock and the minimap can't both fit on the row, the minimap folds into a dock button
 * (`foldMap`) and the dock takes the whole span. `left` is the dock's left edge.
 */
export function dockLayout(d: DockInput): { left: number; foldMap: boolean } {
  const gap = SAFE_GAP
  const start = d.left + gap
  // A panel on the right covers the minimap's corner, so the map only shares the row when nothing's there.
  const mapOnRow = d.mapWidth !== null && d.right >= d.stageWidth
  const mapEdge = mapOnRow ? d.stageWidth - SAFE_MARGIN - d.mapWidth! - gap : d.right - gap
  const foldMap = mapOnRow && mapEdge - start < d.dockWidth
  const width = d.dockWidth + (foldMap ? (d.mapButton ?? 34) : 0)
  const end = foldMap ? d.right - gap : mapEdge
  // Centred on the canvas the person sees, moved left only as far as the minimap needs.
  const centred = (start + d.right - gap) / 2 - width / 2
  // Too narrow for even that: keep it clear of the sidebar, and let it run under the panel, which it's drawn above.
  const left = Math.max(start, Math.min(centred, end - width))
  return { left: Math.round(left), foldMap }
}

/** The view, at this zoom, that puts a canvas point in the middle of the safe area (screen pixels within the canvas). */
export function centredIn(safe: Rect, at: { x: number; y: number }, zoom: number): { x: number; y: number; zoom: number } {
  return { x: safe.x + safe.width / 2 - at.x * zoom, y: safe.y + safe.height / 2 - at.y * zoom, zoom }
}

