import { useEffect } from 'react'
import type { Rect } from '../core/canvas/place'
import { CHROME_EVENT, measureSafeArea } from './safeArea'

declare global {
  interface Window {
    patchbayView?: { reportArea(area: Rect): void }
  }
}

/**
 * The part of the canvas the person can see: the safe area, clear of the sidebar, dock, minimap, legend and any panel
 * on the right (see safeArea). In the canvas element's own pixels: the space the viewport's x and y are in. Null
 * before the canvas is drawn. `sidebar` is the setting, which counts while the sidebar is still opening or closing.
 */
export function visibleArea(sidebar: boolean): Rect | null {
  return measureSafeArea(sidebar)
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
    // Chrome coming or going (the legend, a panel, the minimap folding) changes the area too.
    window.addEventListener(CHROME_EVENT, report)
    // The canvas may not be drawn yet on the first run.
    const late = setTimeout(report, 1000)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener(CHROME_EVENT, report)
      clearTimeout(late)
    }
  }, [sidebar])
}
