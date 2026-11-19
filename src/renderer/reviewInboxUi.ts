import { create } from 'zustand'
import type { CommentView, ReviewBridge, ReviewSide } from '../shared/reviewInbox'

declare global {
  interface Window {
    patchbayReview: ReviewBridge
  }
}

/** The inbox's calls to main. Looked up on use, so this module loads where there's no window, as in tests. */
export const reviewBridge = (): ReviewBridge => window.patchbayReview

/** Whether the review inbox is open, and on which task. Actions, menus and the board open it from anywhere. */
export const useReviewInbox = create<{ open: boolean; taskId: string | null }>(() => ({ open: false, taskId: null }))

export function toggleReviewInbox(): void {
  useReviewInbox.setState((s) => ({ open: !s.open }))
}

export function openReviewInbox(taskId?: string): void {
  useReviewInbox.setState((s) => ({ open: true, taskId: taskId ?? s.taskId }))
}

export function closeReviewInbox(): void {
  useReviewInbox.setState({ open: false })
}

/**
 * Which comments show on a line of a diff. A comment shows at the line it was written on when this diff's side is
 * the very revision it was written on; otherwise at where it is now, but only when this diff's side is the code as
 * it is now (`current`). Anywhere else it's only in the list, so a comment is never shown against code it wasn't on.
 */
export function commentsOnLine(comments: CommentView[], o: { path: string; side: ReviewSide; line: number; revision: string; current: boolean }): CommentView[] {
  return comments.filter((c) => {
    if (c.anchor.path !== o.path || c.anchor.side !== o.side) return false
    if (c.anchor.revision === o.revision) return c.anchor.line === o.line
    return o.current && c.placement.kind !== 'outdated' && c.placement.line === o.line
  })
}

const AGO = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
export function ago(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000)
  if (Math.abs(s) < 60) return AGO.format(s, 'second')
  if (Math.abs(s) < 3600) return AGO.format(Math.round(s / 60), 'minute')
  if (Math.abs(s) < 86400) return AGO.format(Math.round(s / 3600), 'hour')
  return AGO.format(Math.round(s / 86400), 'day')
}
