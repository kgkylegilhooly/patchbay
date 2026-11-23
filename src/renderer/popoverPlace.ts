/**
 * Where a popover opened from a chip goes: under the chip, moved left to stay in the window, and stopped above
 * `floor`, the top of the chrome along the bottom (the dock and the minimap), so it never covers them. When there
 * isn't room under the chip for it, it moves up. Pure, so it's tested without a window.
 */
export interface PopoverPlace {
  x: number
  y: number
  maxHeight: number
}

const EDGE = 8
/** Shorter than this under the chip, and it moves up rather than squeezing. */
const MIN_ROOM = 240

export function popoverPlace(
  at: { x: number; y: number },
  size: { width: number; height: number },
  window: { width: number; height: number },
  floor: number | null
): PopoverPlace {
  // A floor above the chip itself (the chip is down among the chrome) is no use: the window's edge is the floor then.
  const bottom = floor !== null && floor > at.y ? Math.min(floor, window.height - EDGE) : window.height - EDGE
  const x = Math.max(EDGE, Math.min(at.x, window.width - size.width - EDGE))
  const room = bottom - at.y
  if (room >= Math.min(size.height, MIN_ROOM)) return { x, y: at.y, maxHeight: room }
  const y = Math.max(EDGE, bottom - size.height)
  return { x, y, maxHeight: bottom - y }
}
