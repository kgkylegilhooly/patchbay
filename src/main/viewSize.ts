import type { Rect, Size } from '../core/canvas/place'

/**
 * What part of the canvas window the person can see, so nodes added from the main process can land there. The page
 * reports the visible canvas area (less the sidebar and dock, in the canvas's own pixels) whenever it changes; until
 * it has, the window's content size stands in. Without a window, as in tests, it's unknown and placement does without.
 */
let read: (() => Size | null) | null = null
let area: Rect | null = null

export function reportViewSize(fn: () => Size | null): void {
  read = fn
}

/** The page's own measure of the visible canvas. Anything that isn't four finite numbers with a size is ignored. */
export function reportViewArea(value: unknown): void {
  const r = value as Partial<Rect> | null
  const ok = !!r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)) && r.width! > 0 && r.height! > 0
  if (ok) area = { x: r!.x!, y: r!.y!, width: r!.width!, height: r!.height! }
}

export function viewSize(): Size | Rect | null {
  if (area) return area
  try {
    return read?.() ?? null
  } catch {
    return null
  }
}
