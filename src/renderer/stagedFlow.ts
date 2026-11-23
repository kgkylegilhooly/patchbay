import type { Viewport } from '@xyflow/react'
import type { FlowEdge, FlowNode } from './flowMapping'

/**
 * A project switch draws the windows on screen first and the rest a frame later. Every window of the project mounting
 * in the switch's frame (React, the canvas's layout of all of them) made that frame ~70 ms on a busy project, though
 * half of them were off screen. Those off screen can't be seen arriving a frame later. See docs/plans/r2-perf.md.
 */

export interface Size {
  width: number
  height: number
}

/** How far past each edge of the view a window still counts as on screen, as a part of the view's size. */
const MARGIN = 0.15

/** Each node's place on the canvas, its parents' positions added in (a child's position is its parent's offset). */
function absolute(nodes: FlowNode[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const at = new Map<string, { x: number; y: number }>()
  const place = (n: FlowNode, depth = 0): { x: number; y: number } => {
    const known = at.get(n.id)
    if (known) return known
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    const base = parent && depth < 32 ? place(parent, depth + 1) : { x: 0, y: 0 }
    const p = { x: base.x + n.position.x, y: base.y + n.position.y }
    at.set(n.id, p)
    return p
  }
  for (const n of nodes) place(n)
  return at
}

/**
 * The nodes to draw in a switch's first frame: those on or near the screen at `viewport`, with every parent they need
 * (React Flow needs a child's parent drawn), in their order. Null when holding some back gains nothing: all of them
 * are near, or none is (an empty view would show the empty-canvas hint for a frame).
 */
export function nearView(nodes: FlowNode[], viewport: Viewport, view: Size): FlowNode[] | null {
  if (!nodes.length || view.width <= 0 || view.height <= 0) return null
  const at = absolute(nodes)
  const left = -MARGIN * view.width
  const right = (1 + MARGIN) * view.width
  const top = -MARGIN * view.height
  const bottom = (1 + MARGIN) * view.height
  const keep = new Set<string>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    const p = at.get(n.id)!
    const x1 = p.x * viewport.zoom + viewport.x
    const y1 = p.y * viewport.zoom + viewport.y
    const x2 = x1 + (n.width ?? 0) * viewport.zoom
    const y2 = y1 + (n.height ?? 0) * viewport.zoom
    if (x2 < left || x1 > right || y2 < top || y1 > bottom) continue
    for (let c: FlowNode | undefined = n, depth = 0; c && !keep.has(c.id) && depth < 32; c = c.parentId ? byId.get(c.parentId) : undefined, depth++) keep.add(c.id)
  }
  if (keep.size === 0 || keep.size === nodes.length) return null
  return nodes.filter((n) => keep.has(n.id))
}

/** The cables both of whose ends are drawn. */
export function edgesAmong(edges: FlowEdge[], nodes: FlowNode[]): FlowEdge[] {
  const drawn = new Set(nodes.map((n) => n.id))
  return edges.filter((e) => drawn.has(e.source) && drawn.has(e.target))
}

/**
 * Decides, for each doc the canvas draws, what to draw now. A doc showing another project than the last one draws
 * only what's near the view and asks for `later` (the rest, once that frame is drawn). Anything else draws the whole
 * project, which also ends a wait early. Pure apart from what it remembers, so it can be tested.
 */
export function createStager(): {
  pick(projectId: string, flow: { nodes: FlowNode[]; edges: FlowEdge[] }, viewport: Viewport, view: Size | null): { nodes: FlowNode[]; edges: FlowEdge[]; later: boolean }
} {
  let shown: string | null = null
  return {
    pick(projectId, flow, viewport, view) {
      const switched = shown !== projectId
      shown = projectId
      const near = switched && view ? nearView(flow.nodes, viewport, view) : null
      if (!near) return { ...flow, later: false }
      return { nodes: near, edges: edgesAmong(flow.edges, near), later: true }
    }
  }
}
