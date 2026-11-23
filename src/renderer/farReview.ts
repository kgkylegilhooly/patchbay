import { create } from 'zustand'
import type { Viewport } from '../shared/model'

/**
 * A prompt answered from a zoomed-out tile. The tile can't show the whole command, so it offers Deny, which is safe,
 * and Review…, which zooms to the window with its approval strip showing the whole command, where Approve is. Nobody
 * approves a command they couldn't read. The parts here are pure, so they're tested without a window.
 */

/** The request whose strip should open on its whole command once the view gets there. */
export const useFarReview = create<{ requestId: string | null }>(() => ({ requestId: null }))

export const askReview = (requestId: string): void => useFarReview.setState({ requestId })
export const reviewShown = (): void => useFarReview.setState({ requestId: null })

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The zooms a review lands at: never below where a header and its strip read well, never past full size. */
export const REVIEW_ZOOM = { min: 0.85, max: 1 }
const MARGIN = 32

/**
 * The view for reviewing `node` (canvas coordinates) in `area` (the visible canvas, in screen pixels): as large as fits,
 * within REVIEW_ZOOM. It's centred when it fits; otherwise its top left is kept in view, since that's where the header
 * and the approval strip are.
 */
export function reviewViewport(node: Rect, area: Rect): Viewport {
  const fit = Math.min((area.width - 2 * MARGIN) / Math.max(node.width, 1), (area.height - 2 * MARGIN) / Math.max(node.height, 1))
  const zoom = Math.min(REVIEW_ZOOM.max, Math.max(REVIEW_ZOOM.min, fit))
  const w = node.width * zoom
  const h = node.height * zoom
  const x = w <= area.width - 2 * MARGIN ? area.x + (area.width - w) / 2 : area.x + MARGIN
  const y = h <= area.height - 2 * MARGIN ? area.y + (area.height - h) / 2 : area.y + MARGIN
  return { x: x - node.x * zoom, y: y - node.y * zoom, zoom }
}
