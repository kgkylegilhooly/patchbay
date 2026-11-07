export type Direction = 'left' | 'right' | 'up' | 'down'

export interface NavRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * The node to move to from this one: the nearest whose center lies that way. Sideways distance counts for more, so
 * pressing right prefers the window beside this one over a closer one far above it. Null if nothing lies that way.
 */
export function nearestInDirection(rects: NavRect[], fromId: string | null, direction: Direction): string | null {
  const from = rects.find((r) => r.id === fromId)
  if (!from) return rects[0]?.id ?? null
  const fx = from.x + from.width / 2
  const fy = from.y + from.height / 2
  let best: { id: string; score: number } | null = null
  for (const r of rects) {
    if (r.id === from.id) continue
    const dx = r.x + r.width / 2 - fx
    const dy = r.y + r.height / 2 - fy
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    if (along <= 0) continue
    const score = along + across * 2
    if (!best || score < best.score) best = { id: r.id, score }
  }
  return best?.id ?? null
}
