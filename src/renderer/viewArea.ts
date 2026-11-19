import { useEffect } from 'react'
import type { Rect } from '../core/canvas/place'

declare global {
  interface Window {
    patchbayView?: { reportArea(area: Rect): void }
  }
}

/** What the sidebar and dock cover, as Fit all leaves clear. */
const INSET = { top: 24, right: 24, bottom: 84 }
export const sidebarInset = (sidebar: boolean): number => (sidebar ? 330 : 24)

/**
 * The part of the canvas the person can see, in the canvas element's own pixels: the space the viewport's x and y are
 * in. Null before the canvas is drawn.
 */
export function visibleArea(sidebar: boolean): Rect | null {
  const el = document.querySelector('.react-flow')
  if (!el) return null
  const { width, height } = el.getBoundingClientRect()
  const left = sidebarInset(sidebar)
  const area = { x: left, y: INSET.top, width: width - left - INSET.right, height: height - INSET.top - INSET.bottom }
  return area.width > 0 && area.height > 0 ? area : null
}

/** Keeps main told of the visible area, so nodes it adds (an agent's note, a handoff) land in view. */
export function useViewAreaReport(sidebar: boolean): void {
  useEffect(() => {
    const report = (): void => {
      const area = visibleArea(sidebar)
      if (area) window.patchbayView?.reportArea(area)
    }
    report()
    const el = document.querySelector('.react-flow')
    const observer = typeof ResizeObserver === 'function' && el ? new ResizeObserver(report) : null
    if (el) observer?.observe(el)
    window.addEventListener('resize', report)
    // The canvas may not be drawn yet on the first run.
    const late = setTimeout(report, 1000)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
      clearTimeout(late)
    }
  }, [sidebar])
}
