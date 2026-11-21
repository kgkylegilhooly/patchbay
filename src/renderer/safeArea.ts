import { useEffect } from 'react'
import { create } from 'zustand'
import { dockLayout, fitPadding, SAFE_GAP, safeRect } from '../core/canvas/safeArea'
import type { Rect, Size } from '../core/canvas/place'

/**
 * The chrome over the canvas, measured where it is now: the sessions sidebar, the dock, the minimap, the link legend,
 * and a panel on the right (the Git panel, a drawer). See core/canvas/safeArea for the rules.
 */

/** Panels that sit on the right edge. One wider than this share of the canvas is a view of its own, not a panel. */
const RIGHT_PANELS = '.stage > .drawer, .stage > .git-panel, .stage > .shell-drawer:not(.shell-beside)'
const PANEL_SHARE = 0.6
/** The sidebar's room while it's opening and not drawn yet: its width and its inset from the edge. */
const SIDEBAR_STANDIN = 314
/** The minimap's width (React Flow's default) and the Map button that stands in for it when folded. */
const MAP_WIDTH = 200

/** Whether the minimap is folded into the dock for want of room, and whether it's been shown from there. */
export const useChromeLayout = create<{ foldMap: boolean; mapOpen: boolean }>(() => ({ foldMap: false, mapOpen: false }))
export const toggleFoldedMap = (): void => useChromeLayout.setState((s) => ({ mapOpen: !s.mapOpen }))

const pane = (): Element | null => document.querySelector('.react-flow')

/** A box that's drawn, in the canvas element's pixels. */
function boxOf(el: Element | null, origin: DOMRect): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height } : null
}

function rightPanels(origin: DOMRect): Rect[] {
  return [...document.querySelectorAll(RIGHT_PANELS)]
    .map((el) => boxOf(el, origin))
    .filter((r): r is Rect => !!r && r.width < origin.width * PANEL_SHARE)
}

/**
 * The stage's size and the boxes chrome covers on it. `sidebar` is what the setting says: while the sidebar is opening
 * it may not be drawn yet, so a stand-in is used, and one on its way out is left out.
 */
export function measureChrome(sidebar?: boolean): { stage: Size; covers: Rect[] } | null {
  const el = pane()
  if (!el) return null
  const origin = el.getBoundingClientRect()
  if (!origin.width || !origin.height) return null
  const covers: Rect[] = []
  const side = sidebar === false ? null : boxOf(document.querySelector('.stage > .sidebar'), origin)
  if (side) covers.push(side)
  else if (sidebar === true) covers.push({ x: 0, y: 0, width: SIDEBAR_STANDIN, height: origin.height })
  for (const sel of ['.stage > .dock', '.react-flow__minimap', '.stage > .legend']) {
    const box = boxOf(document.querySelector(sel), origin)
    if (box) covers.push(box)
  }
  covers.push(...rightPanels(origin))
  return { stage: { width: origin.width, height: origin.height }, covers }
}

/** The safe area now, in the canvas element's pixels: the space the viewport's x and y are in. Null before it's drawn. */
export function measureSafeArea(sidebar?: boolean): Rect | null {
  const m = measureChrome(sidebar)
  return m ? safeRect(m.stage, m.covers) : null
}

/** The canvas element's size, for turning the safe area into fit view's padding. */
export function stageSize(): Size | null {
  const r = pane()?.getBoundingClientRect()
  return r && r.width && r.height ? { width: r.width, height: r.height } : null
}

/** Told whenever chrome comes, goes or changes size, so the area main places into stays current. */
export const CHROME_EVENT = 'pb:chrome'

/** Lays the dock out in the free part of the bottom row, folds the minimap when they can't share it, and says so. */
function layOut(stage: HTMLElement, mapOn: boolean): void {
  const origin = stage.getBoundingClientRect()
  const dock = stage.querySelector(':scope > .dock')
  if (!origin.width || !dock) return
  const side = stage.querySelector(':scope > .sidebar')?.getBoundingClientRect()
  const panels = rightPanels(origin)
  const mapButton = dock.querySelector('.dock-map')?.getBoundingClientRect().width ?? 0
  const { left, foldMap } = dockLayout({
    stageWidth: origin.width,
    left: side && side.width ? side.right - origin.left : 0,
    right: panels.length ? Math.min(...panels.map((p) => p.x)) : origin.width,
    dockWidth: dock.getBoundingClientRect().width - mapButton,
    mapWidth: mapOn ? MAP_WIDTH : null
  })
  stage.style.setProperty('--dock-left', `${left}px`)
  stage.dataset.dockPlaced = ''
  // Only when the dock runs under a panel: it's drawn above it, and the panel keeps its last rows clear of it.
  const dockBox = dock.getBoundingClientRect()
  const under = panels.some((p) => left + dockBox.width > p.x)
  if (under) {
    stage.dataset.dockRaised = ''
    stage.style.setProperty('--dock-room', `${Math.round(origin.bottom - dockBox.top + SAFE_GAP)}px`)
  } else delete stage.dataset.dockRaised
  if (useChromeLayout.getState().foldMap !== foldMap) useChromeLayout.setState({ foldMap, ...(foldMap ? {} : { mapOpen: false }) })
}

/**
 * Watches the chrome over the canvas: lays the dock out whenever the window, the sidebar, the dock or a panel changes,
 * and tells listeners (CHROME_EVENT) so the visible area is reported again.
 */
export function useChromeWatch(mapOn: boolean, ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    const stage = document.querySelector<HTMLElement>('.stage')
    if (!stage) return
    let frame = 0
    const run = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        layOut(stage, mapOn)
        window.dispatchEvent(new Event(CHROME_EVENT))
      })
    }
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(run) : null
    const watchSizes = (): void => {
      sizes?.disconnect()
      sizes?.observe(stage)
      for (const el of stage.querySelectorAll(':scope > .dock, :scope > .sidebar, :scope > .legend, .react-flow__minimap, :scope > .drawer, :scope > .git-panel, :scope > .shell-drawer')) sizes?.observe(el)
    }
    // Chrome comes and goes as children of the stage; the minimap inside the canvas.
    const children = new MutationObserver(() => {
      watchSizes()
      run()
    })
    children.observe(stage, { childList: true })
    const flow = stage.querySelector('.react-flow')
    if (flow) children.observe(flow, { childList: true })
    watchSizes()
    run()
    window.addEventListener('resize', run)
    return () => {
      cancelAnimationFrame(frame)
      sizes?.disconnect()
      children.disconnect()
      window.removeEventListener('resize', run)
    }
  }, [mapOn, ready])
}

/**
 * Fit view's padding for the safe area as it is now, with `extra` pixels of air: so "fit" and "show this node" frame
 * things where the chrome doesn't cover them.
 */
export function safePadding(extra = 32, sidebar?: boolean): ReturnType<typeof fitPadding> {
  const stage = stageSize()
  return fitPadding(stage ?? { width: 0, height: 0 }, stage ? measureSafeArea(sidebar) : null, extra)
}
