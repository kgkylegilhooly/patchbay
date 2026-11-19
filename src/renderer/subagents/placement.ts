import type { Rect } from '../flowMapping'

/** A card's size on the canvas, and the space between cards and from the window. */
export const CARD = { width: 260, height: 78 }
export const CARD_GAP = 10
const SIDE_GAP = 56

export type Side = 'right' | 'left' | 'below'

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Where a window's cards go: a column on its right, else on its left, else a row below it, whichever side holds them
 * all without covering another window. The one place subagent cards are placed, so a shared placement helper (see
 * fix/placement) can replace it. `others` are the other windows' rectangles, groups left out.
 */
export function cardSpots(parent: Rect, count: number, others: Rect[]): { side: Side; spots: Rect[] } {
  const column = (x: number): Rect[] => Array.from({ length: count }, (_, i) => ({ x, y: parent.y + i * (CARD.height + CARD_GAP), ...CARD }))
  const candidates: Array<{ side: Side; spots: Rect[] }> = [
    { side: 'right', spots: column(parent.x + parent.width + SIDE_GAP) },
    { side: 'left', spots: column(parent.x - SIDE_GAP - CARD.width) },
    {
      side: 'below',
      spots: Array.from({ length: count }, (_, i) => ({ x: parent.x + i * (CARD.width + CARD_GAP), y: parent.y + parent.height + SIDE_GAP, ...CARD }))
    }
  ]
  const clear = candidates.find((c) => c.spots.every((s) => !others.some((o) => overlaps(s, o))))
  return clear ?? candidates[0]
}
