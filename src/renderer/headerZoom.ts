import type { Viewport } from '../shared/model'

/**
 * Double-clicking an empty part of a node's header zooms the canvas to that node, and doing it again, or Esc, goes
 * back to exactly where the view was. The parts here are pure, so the memory can be tested without a window.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The view that shows `node` (flow coordinates) centered in `area` (screen pixels within the canvas), as large as fits
 * with `margin` pixels to spare on each side, within the canvas's zoom limits.
 */
export function viewportFor(node: Rect, area: Rect, opts: { margin: number; minZoom: number; maxZoom: number }): Viewport {
  const fitW = (area.width - 2 * opts.margin) / Math.max(node.width, 1)
  const fitH = (area.height - 2 * opts.margin) / Math.max(node.height, 1)
  const zoom = Math.min(opts.maxZoom, Math.max(opts.minZoom, Math.min(fitW, fitH)))
  return {
    x: area.x + area.width / 2 - (node.x + node.width / 2) * zoom,
    y: area.y + area.height / 2 - (node.y + node.height / 2) * zoom,
    zoom
  }
}

/** Whether two views are the same, give or take what animating and rounding leave. */
export function sameViewport(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.001
}

/** Where the view was before zooming to a node, and where that zoom put it. */
export interface ZoomMemory {
  nodeId: string
  previous: Viewport
  zoomed: Viewport
}

/**
 * A double-click on a node's header. Zoomed to this node and still there: go back. Otherwise zoom to it, remembering
 * the view now. `target` is the view that shows the node.
 */
export function onHeaderDoubleClick(memory: ZoomMemory | null, nodeId: string, current: Viewport, target: Viewport): { go: Viewport; memory: ZoomMemory | null } {
  if (memory && memory.nodeId === nodeId && sameViewport(current, memory.zoomed)) return { go: memory.previous, memory: null }
  // Zooming from one node straight to another keeps the view from before the first, so Back still returns there.
  const previous = memory && sameViewport(current, memory.zoomed) ? memory.previous : current
  return { go: target, memory: { nodeId, previous, zoomed: target } }
}

/** Esc: back to the view from before, while the view is still where the zoom put it. Null when there's nothing to undo. */
export function onEscape(memory: ZoomMemory | null, current: Viewport): { go: Viewport } | null {
  return memory && sameViewport(current, memory.zoomed) ? { go: memory.previous } : null
}

/** The view stopped moving. Anywhere other than where the zoom put it means the person moved it: forget going back. */
export function afterMove(memory: ZoomMemory | null, current: Viewport): ZoomMemory | null {
  return memory && sameViewport(current, memory.zoomed) ? memory : null
}

/** What in a header keeps its own double-click: the title renames, and controls are controls. */
const OWN_DOUBLE_CLICK = 'button, input, textarea, select, a, label, [contenteditable], [role="button"], .title, .nodrag'

/** Whether a double-click landed on the header's empty part, rather than on something in it with its own use. */
export function isEmptyHeaderPart(target: Element | null, header: Element): boolean {
  for (let el: Element | null = target; el && el !== header; el = el.parentElement) {
    if (el.matches(OWN_DOUBLE_CLICK)) return false
  }
  return !!target && header.contains(target)
}
