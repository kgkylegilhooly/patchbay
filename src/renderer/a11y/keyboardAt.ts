/**
 * Which window the window actions mean (Rename, Restart, Close, Refresh, Maximize, font, Name with AI). It's decided by
 * where the keyboard is now, never by the terminal typed in last: that one stays remembered for the Edit menu, but
 * acting on it after the keyboard moved on renamed or closed the wrong window (review H1).
 *
 * While the command palette has the keyboard, "now" means where it was when the palette opened, which is also where the
 * palette gives it back.
 */

/** Where the keyboard is, in the terms the choice needs. */
export interface KeyboardSpot {
  /** A terminal's text box has it: that terminal's window. */
  terminal?: string | null
  /** Inside a window's frame, or on the frame itself: that window, and whether it's a session. */
  frame?: { id: string; session: boolean } | null
}

/**
 * The window to act on: one filling the canvas, else the one the keyboard is in (none, if that's a note or a board),
 * else a single selected session. Null when there's none, so nothing is renamed or closed by surprise.
 */
export function windowFor(spot: KeyboardSpot, maximized: string | null, selectedSession: string | null): string | null {
  if (maximized) return maximized
  if (spot.terminal) return spot.terminal
  if (spot.frame) return spot.frame.session ? spot.frame.id : null
  return selectedSession
}

/** The last element outside the palette that had the keyboard, while it still has it or the palette was opened from it. */
let outside: Element | null = null

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (el && !el.closest('.palette')) outside = el
  })
  // Focus going to the page (a click on the empty canvas): nothing outside the palette has it any more.
  document.addEventListener('focusout', (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (!e.relatedTarget && el && !el.closest('.palette')) outside = null
  })
}

/** The element the keyboard is on, or was on when the palette opened. Null for the page itself. */
export function keyboardElement(): Element | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (!active || active === document.body) return null
  if (active.closest('.palette')) return outside?.isConnected ? outside : null
  return active
}

/** The window id the element belongs to: its frame on the canvas, or the focus view pane its card was moved into. */
export function windowOfElement(el: Element | null): string | null {
  const frame = el?.closest<HTMLElement>('.react-flow__node, [data-focus-slot]')
  return frame?.dataset.id ?? frame?.dataset.focusSlot ?? null
}
