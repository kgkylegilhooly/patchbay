/**
 * The project tabs scroll sideways when there are more than fit. These say which tabs are out of sight, for the
 * "N more" menu, and where to scroll so the tab on screen is shown. Pure, so they're tested without a page.
 */

export interface Span {
  left: number
  right: number
}

/** A tab cut off by less than this still reads as shown. */
const SLACK = 2

/** The tabs not wholly inside the visible part of the strip, in order. */
export function hiddenTabs(view: Span, tabs: ReadonlyArray<Span & { id: string }>): string[] {
  return tabs.filter((t) => t.left < view.left - SLACK || t.right > view.right + SLACK).map((t) => t.id)
}

/**
 * The scroll position that shows a tab, moving as little as it can: unchanged when it's already in view. `tab` is
 * measured from the start of the scrolled content, `width` is the strip's visible width.
 */
export function scrollToShow(scrollLeft: number, width: number, tab: Span, margin = 24): number {
  if (tab.left - margin < scrollLeft) return Math.max(0, tab.left - margin)
  if (tab.right + margin > scrollLeft + width) return Math.max(0, tab.right + margin - width)
  return scrollLeft
}

/** The words on the overflow button. */
export function moreLabel(hidden: number): string {
  return `${hidden} more`
}
