import type { Viewport } from '@xyflow/react'
import type { FlowEdge, FlowNode } from './flowMapping'

/**
 * A project switch draws the windows on screen first and the rest a few at a time, nearest first, one batch a frame.
 * Every window of the project mounting in the switch's frame (React, the canvas's layout of all of them) made that frame
 * ~70 ms on a busy project, though half of them were off screen, and drawing all of the rest in the second frame only
 * moved that cost there. Windows off screen can't be seen arriving a frame or three later. See docs/plans/r2-perf.md
 * and docs/plans/r4-leftovers.md.
 */

export interface Size {
  width: number
  height: number
}

/**
 * How far past each edge of the view a window still counts as on screen, as a part of the view's size. None: a window
 * touching the view is drawn, and one wholly past it can't be seen arriving a frame later. (It was 15%, which on a busy
 * project drew a whole group off to the side in the switch's frame: see docs/plans/r4-leftovers.md.)
 */
const MARGIN = 0

/** How many more windows each frame after the first draws (their groups come too). ~2-3 ms each on a busy project. */
export const BATCH = 8

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

/** How far each node is from the view, in screen pixels (0 for one on or touching it, within the margin). */
function distances(nodes: FlowNode[], viewport: Viewport, view: Size): Map<string, number> {
  const at = absolute(nodes)
  const left = -MARGIN * view.width
  const right = (1 + MARGIN) * view.width
  const top = -MARGIN * view.height
  const bottom = (1 + MARGIN) * view.height
  const out = new Map<string, number>()
  for (const n of nodes) {
    const p = at.get(n.id)!
    const x1 = p.x * viewport.zoom + viewport.x
    const y1 = p.y * viewport.zoom + viewport.y
    const x2 = x1 + (n.width ?? 0) * viewport.zoom
    const y2 = y1 + (n.height ?? 0) * viewport.zoom
    const dx = x2 < left ? left - x2 : x1 > right ? x1 - right : 0
    const dy = y2 < top ? top - y2 : y1 > bottom ? y1 - bottom : 0
    out.set(n.id, Math.hypot(dx, dy))
  }
  return out
}

/** Adds a node and every parent it needs (React Flow needs a child's parent drawn). */
function addWithParents(keep: Set<string>, n: FlowNode, byId: Map<string, FlowNode>): void {
  for (let c: FlowNode | undefined = n, depth = 0; c && !keep.has(c.id) && depth < 32; c = c.parentId ? byId.get(c.parentId) : undefined, depth++) keep.add(c.id)
}

/**
 * The nodes to draw in a switch's first frame: those on or touching the screen at `viewport`, with every parent they
 * need, in their order. Null when holding some back gains nothing: all of them are on screen, or none is (an empty view
 * would show the empty-canvas hint for a frame).
 */
export function nearView(nodes: FlowNode[], viewport: Viewport, view: Size): FlowNode[] | null {
  const keep = nearIds(nodes, viewport, view)
  return keep ? nodes.filter((n) => keep.has(n.id)) : null
}

function nearIds(nodes: FlowNode[], viewport: Viewport, view: Size): Set<string> | null {
  if (!nodes.length || view.width <= 0 || view.height <= 0) return null
  const far = distances(nodes, viewport, view)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const keep = new Set<string>()
  for (const n of nodes) if (far.get(n.id) === 0) addWithParents(keep, n, byId)
  if (keep.size === 0 || keep.size === nodes.length) return null
  return keep
}

/** The next `batch` nodes not yet drawn, nearest the view first, added to `drawn` with their parents. */
export function nextBatch(nodes: FlowNode[], drawn: Set<string>, viewport: Viewport, view: Size, batch = BATCH): void {
  const far = distances(nodes, viewport, view)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const waiting = nodes.filter((n) => !drawn.has(n.id)).sort((a, b) => far.get(a.id)! - far.get(b.id)!)
  for (const n of waiting.slice(0, batch)) addWithParents(drawn, n, byId)
}

/** The cables both of whose ends are drawn. */
export function edgesAmong(edges: FlowEdge[], nodes: FlowNode[]): FlowEdge[] {
  const drawn = new Set(nodes.map((n) => n.id))
  return edges.filter((e) => drawn.has(e.source) && drawn.has(e.target))
}

/**
 * Decides, for each doc the canvas draws, what to draw now. A doc showing another project than the last one draws only
 * what's on screen and asks for `later`; each `advance()` (called once a frame is drawn) lets the next batch in, until
 * the whole project is drawn. A doc or status change meanwhile keeps what's drawn and draws any window that wasn't in
 * the project when it was switched to (one just opened) at once. Pure apart from what it remembers, so it can be tested.
 */
export function createStager(): {
  pick(projectId: string, flow: { nodes: FlowNode[]; edges: FlowEdge[] }, viewport: Viewport, view: Size | null): { nodes: FlowNode[]; edges: FlowEdge[]; later: boolean }
  advance(): void
} {
  let shown: string | null = null
  /** What's drawn while a switch is being staged; null once everything is. */
  let drawn: Set<string> | null = null
  /** The project's windows when it was switched to: any other is new, and drawn at once. */
  let known: Set<string> = new Set()
  let due = 0
  return {
    advance() {
      if (drawn) due++
    },
    pick(projectId, flow, viewport, view) {
      if (shown !== projectId) {
        shown = projectId
        due = 0
        drawn = view ? nearIds(flow.nodes, viewport, view) : null
        known = new Set(flow.nodes.map((n) => n.id))
      } else if (drawn) {
        const byId = new Map(flow.nodes.map((n) => [n.id, n]))
        for (const n of flow.nodes) if (!known.has(n.id)) addWithParents(drawn, n, byId)
        for (; due > 0; due--) if (view) nextBatch(flow.nodes, drawn, viewport, view)
        if (!view) drawn = null
      }
      const keep = drawn
      if (!keep || flow.nodes.every((n) => keep.has(n.id))) {
        drawn = null
        return { ...flow, later: false }
      }
      const nodes = flow.nodes.filter((n) => keep.has(n.id))
      return { nodes, edges: edgesAmong(flow.edges, nodes), later: true }
    }
  }
}
