import { create } from 'zustand'
import { placedPath, type ChangeSection, type CommentView, type ReviewBridge, type ReviewSide } from '../shared/reviewInbox'

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
 * Where each comment shows in one diff, keyed "side:line", worked out once per diff rather than per line. A comment
 * shows at the line it was written on when this diff's side is the very revision it was written on. Otherwise it
 * shows where it is now, but only when this diff's side is the code it's placed against now: for the new side, the
 * file as it is (`currentNew`); for the old side, the current "from" of the comment's own list (`currentOld`, and
 * the same list). Anywhere else it's only in the list, so a comment never shows against code it wasn't on.
 */
export function commentsByLine(comments: CommentView[], o: { path: string; oldPath?: string; section: ChangeSection; from: string; to: string; currentNew: boolean; currentOld: boolean }): Map<string, CommentView[]> {
  const out = new Map<string, CommentView[]>()
  const put = (side: ReviewSide, line: number, c: CommentView): void => {
    const k = `${side}:${line}`
    out.set(k, [...(out.get(k) ?? []), c])
  }
  for (const c of comments) {
    const side = c.anchor.side
    // A renamed file's old side is its old path; a comment followed through a rename is where the rename took it.
    const file = side === 'old' ? (o.oldPath ?? o.path) : o.path
    if (c.anchor.revision === (side === 'new' ? o.to : o.from)) {
      if (c.anchor.path === file) put(side, c.anchor.line, c)
    } else if (c.placement.kind !== 'outdated' && placedPath(c) === file) {
      if (side === 'new' && o.currentNew) put(side, c.placement.line, c)
      if (side === 'old' && o.currentOld && (c.anchor.section ?? 'committed') === o.section) put(side, c.placement.line, c)
    }
  }
  return out
}

const AGO = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
export function ago(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000)
  if (Math.abs(s) < 60) return AGO.format(s, 'second')
  if (Math.abs(s) < 3600) return AGO.format(Math.round(s / 60), 'minute')
  if (Math.abs(s) < 86400) return AGO.format(Math.round(s / 3600), 'hour')
  return AGO.format(Math.round(s / 86400), 'day')
}
