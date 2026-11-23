import type { ZoomTier } from './zoomTier'

/**
 * How often a terminal draws its output, by how much you can see of it. Drawing is the biggest steady cost in the
 * window: with dozens of terminals printing, xterm rebuilding rows left no headroom on a modest PC. A terminal you're
 * typing in draws at once; one under the pointer, or on a canvas near enough to read, ten times a second; one zoomed
 * out to a small tile four times a second; one you can't read at all (the overview's flat fills, or a project not on
 * show) once a second. Its output is never dropped, only gathered.
 */
export const PACE_MS = { near: 100, far: 250, hidden: 1000 } as const

export interface PaceInput {
  focused: boolean
  hovered: boolean
  tier: ZoomTier
  /** Not on the canvas: kept for a project that isn't on show. */
  offstage?: boolean
}

/** 0 means at once. */
export function paceFor(p: PaceInput): number {
  if (p.focused) return 0
  if (p.offstage || p.tier === 'overview') return PACE_MS.hidden
  if (p.hovered || p.tier === 'near') return PACE_MS.near
  return PACE_MS.far
}

let tier: ZoomTier = 'near'
const onTier = new Set<() => void>()

export const canvasTier = (): ZoomTier => tier

/** Set by ZoomTierWatcher. Coming in closer, held output is drawn at once rather than at the slower pace. */
export function setCanvasTier(next: ZoomTier): void {
  if (next === tier) return
  tier = next
  for (const cb of onTier) cb()
}

export function onCanvasTier(cb: () => void): () => void {
  onTier.add(cb)
  return () => onTier.delete(cb)
}
