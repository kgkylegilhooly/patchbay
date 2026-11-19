import type { AgentStatus, CanvasDoc, CanvasNode, CanvasOp } from '../../shared/model'
import { GROUP_PAD, GROUP_TOP, PLACE_GAP, absoluteRect, placeNear, type Point, type Rect, type Size } from './place'
import { reduce } from './reduce'

/**
 * Tidy: a canonical layout for part of a project. Related nodes stay together (a lead beside the team it opened, a
 * trigger beside its target, a file beside the agent it's cabled to), nothing overlaps, groups move as whole blocks,
 * and running it again changes nothing. Pure: it only says where things go; `tidyOp` turns that into one op.
 */

export type TidyScope = { kind: 'project' } | { kind: 'group'; id: string } | { kind: 'selection'; ids: string[] }

export interface TidyOptions {
  projectId: string
  scope: TidyScope
  /** Agents that need the person first, then working ones, then the rest. Off: creation order. */
  byStatus?: boolean
  statuses?: Readonly<Record<string, AgentStatus | undefined>>
  /** The canvas on screen, in canvas coordinates. Its shape sets how wide the result is. */
  view?: Rect | null
  gap?: number
}

/** A node's new position, relative to its parent as every position is. */
export interface TidyMove {
  id: string
  x: number
  y: number
}

export interface TidyPlan {
  /** What the scope came to: a selection of one group is that group. */
  scope: TidyScope
  /** The group whose members were tidied, or null for top-level nodes. */
  parentId: string | null
  /** What was laid out, in order. */
  units: string[]
  /** Only the nodes that actually move. Empty when it's already tidy. */
  moves: TidyMove[]
}

/** Row widths come in steps this big, so adding one node rarely reflows the rest. */
const WIDTH_STEP = 600
/** A layer of this many or fewer is one column; more make a near-square grid. */
const COLUMN_MAX = 3
const RANK: Record<AgentStatus, number> = { 'needs-you': 0, working: 1, starting: 2, queued: 2, idle: 3, unknown: 4, exited: 5 }
const NO_STATUS = 6

const right = (r: Rect): number => r.x + r.width
const bottom = (r: Rect): number => r.y + r.height
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)
const widen = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by })
const inProject = (n: CanvasNode, projectId: string): boolean => !n.projectId || n.projectId === projectId

interface Scoped {
  scope: TidyScope
  parentId: string | null
  units: CanvasNode[]
}

function topOf(byId: Map<string, CanvasNode>, node: CanvasNode): CanvasNode {
  let at = node
  const seen = new Set([node.id])
  while (at.parentId) {
    const parent = byId.get(at.parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    at = parent
  }
  return at
}

/** Which nodes are laid out, and inside what. Units come in the doc's order, which is the order they were made. */
export function resolveScope(doc: Pick<CanvasDoc, 'nodes'>, projectId: string, scope: TidyScope): Scoped | null {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const order = new Map(doc.nodes.map((n, i) => [n.id, i]))
  const sorted = (nodes: CanvasNode[]): CanvasNode[] => [...new Set(nodes)].sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  if (scope.kind === 'project') {
    return { scope, parentId: null, units: doc.nodes.filter((n) => !n.parentId && inProject(n, projectId)) }
  }
  if (scope.kind === 'group') {
    const group = byId.get(scope.id)
    if (!group || group.kind !== 'group' || !inProject(group, projectId)) return null
    return { scope, parentId: group.id, units: doc.nodes.filter((n) => n.parentId === group.id) }
  }
  const picked = sorted(scope.ids.map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n && inProject(n, projectId)))
  if (picked.length === 0) return null
  if (picked.length === 1 && picked[0].kind === 'group') return resolveScope(doc, projectId, { kind: 'group', id: picked[0].id })
  const parents = new Set(picked.map((n) => n.parentId ?? null))
  if (parents.size === 1) return { scope, parentId: [...parents][0], units: picked }
  // Nodes from different groups: each counts as the top-level block it's in, as a group named with its child wins.
  return { scope, parentId: null, units: sorted(picked.map((n) => topOf(byId, n))) }
}

/** Every cable, `openedBy` and trigger target, from the one that comes first to the one that follows. */
function links(doc: Pick<CanvasDoc, 'nodes' | 'edges'>): [string, string][] {
  const out: [string, string][] = doc.edges.map((e) => [e.from, e.to])
  for (const n of doc.nodes) {
    if (n.openedBy) out.push([n.openedBy, n.id])
    if (n.kind === 'trigger' && n.targetId) out.push([n.id, n.targetId])
  }
  return out
}

interface Block {
  width: number
  height: number
  at: Map<string, Point>
}

/** Cells in rows of `columns`, each column as wide as its widest, each row as tall as its tallest. */
function grid(sizes: Size[], columns: number, gap: number): { at: Point[]; width: number; height: number } {
  const widths: number[] = []
  const heights: number[] = []
  sizes.forEach((s, i) => {
    widths[i % columns] = Math.max(widths[i % columns] ?? 0, s.width)
    heights[Math.floor(i / columns)] = Math.max(heights[Math.floor(i / columns)] ?? 0, s.height)
  })
  const starts = (lengths: number[]): number[] => lengths.map((_, i) => lengths.slice(0, i).reduce((sum, l) => sum + l + gap, 0))
  const xs = starts(widths)
  const ys = starts(heights)
  const span = (lengths: number[]): number => lengths.reduce((sum, l) => sum + l, 0) + gap * Math.max(0, lengths.length - 1)
  return { at: sizes.map((_, i) => ({ x: xs[i % columns], y: ys[Math.floor(i / columns)] })), width: span(widths), height: span(heights) }
}

/**
 * One cluster, in layers left to right along its cables: what comes first (a lead, a trigger) on the left, what it
 * opened or aims at to its right. Within a layer, children follow their parents' order.
 */
function layoutCluster(members: CanvasNode[], next: Map<string, string[]>, before: (a: CanvasNode, b: CanvasNode) => number, gap: number): Block {
  const byId = new Map(members.map((n) => [n.id, n]))
  const sorted = [...members].sort(before)
  const hasIncoming = new Set<string>()
  for (const n of members) for (const t of next.get(n.id) ?? []) if (t !== n.id && byId.has(t)) hasIncoming.add(t)

  const depth = new Map<string, number>()
  const layers: CanvasNode[][] = []
  const queue: string[] = []
  const visit = (n: CanvasNode, d: number): void => {
    depth.set(n.id, d)
    ;(layers[d] ??= []).push(n)
    queue.push(n.id)
  }
  const roots = sorted.filter((n) => !hasIncoming.has(n.id))
  for (const r of roots.length ? roots : sorted.slice(0, 1)) visit(r, 0)
  for (;;) {
    while (queue.length) {
      const id = queue.shift()!
      const children = (next.get(id) ?? []).map((t) => byId.get(t)).filter((n): n is CanvasNode => !!n && !depth.has(n.id))
      for (const c of [...new Set(children)].sort(before)) if (!depth.has(c.id)) visit(c, depth.get(id)! + 1)
    }
    // Only reachable round a loop of cables: it starts a layer of its own.
    const left = sorted.find((n) => !depth.has(n.id))
    if (!left) break
    visit(left, 0)
  }

  const at = new Map<string, Point>()
  let x = 0
  let height = 0
  for (const layer of layers.filter(Boolean)) {
    const columns = layer.length <= COLUMN_MAX ? 1 : Math.ceil(Math.sqrt(layer.length))
    const g = grid(layer, columns, gap)
    layer.forEach((n, i) => at.set(n.id, { x: x + g.at[i].x, y: g.at[i].y }))
    x += g.width + gap
    height = Math.max(height, g.height)
  }
  return { width: Math.max(0, x - gap), height, at }
}

/** Blocks in rows, in order, each row as wide as fits a target taken from their area and the view's shape. */
function pack(blocks: Block[], view: Rect | null | undefined, gap: number): { at: Map<string, Point>; width: number; height: number } {
  const aspect = view && view.width > 0 && view.height > 0 ? view.width / view.height : 16 / 10
  const area = blocks.reduce((sum, b) => sum + (b.width + gap) * (b.height + gap), 0)
  const widest = Math.max(0, ...blocks.map((b) => b.width))
  const target = Math.max(widest, Math.ceil(Math.sqrt(area * aspect) / WIDTH_STEP) * WIDTH_STEP)
  const at = new Map<string, Point>()
  let x = 0
  let y = 0
  let rowHeight = 0
  let width = 0
  for (const b of blocks) {
    // The target counts a gap after every block, so the last one in a row gets that much back.
    if (x > 0 && x + b.width > target + gap) {
      y += rowHeight + gap
      x = 0
      rowHeight = 0
    }
    for (const [id, p] of b.at) at.set(id, { x: x + p.x, y: y + p.y })
    width = Math.max(width, x + b.width)
    x += b.width + gap
    rowHeight = Math.max(rowHeight, b.height)
  }
  return { at, width, height: y + rowHeight }
}

/**
 * Where the layout already is, if most of it is: the shift that leaves the most units where they are, when at least
 * two agree on it. So after one node is dragged off or added, only that one moves. Ties go to the earliest unit.
 */
function settled(units: CanvasNode[], at: Map<string, Point>): Point | null {
  const votes = new Map<string, { origin: Point; count: number }>()
  for (const n of units) {
    const p = at.get(n.id)!
    const origin = { x: Math.round(n.x - p.x), y: Math.round(n.y - p.y) }
    const key = `${origin.x},${origin.y}`
    const v = votes.get(key) ?? votes.set(key, { origin, count: 0 }).get(key)!
    v.count++
  }
  let best: { origin: Point; count: number } | null = null
  for (const v of votes.values()) if (!best || v.count > best.count) best = v
  return best && best.count >= 2 ? best.origin : null
}

/** Where everything in the scope goes. Null when there's nothing to tidy there. */
export function planTidy(doc: CanvasDoc, opts: TidyOptions): TidyPlan | null {
  const scoped = resolveScope(doc, opts.projectId, opts.scope)
  if (!scoped || scoped.units.length === 0) return null
  const gap = opts.gap ?? PLACE_GAP
  const { units, parentId } = scoped
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const unitIds = new Set(units.map((n) => n.id))
  const order = new Map(units.map((n, i) => [n.id, i]))

  /** The unit a node is drawn as: itself, or the group in scope that holds it. */
  const unitOf = (id: string): string | null => {
    let at = byId.get(id)
    const seen = new Set<string>()
    while (at && !seen.has(at.id)) {
      if (unitIds.has(at.id)) return at.id
      seen.add(at.id)
      at = at.parentId ? byId.get(at.parentId) : undefined
    }
    return null
  }

  const statusOf = (n: CanvasNode): number => {
    const s = opts.statuses?.[n.id]
    return s ? RANK[s] ?? NO_STATUS : NO_STATUS
  }
  /** A group counts as its most urgent member. */
  const statusRank = (unit: CanvasNode): number => {
    if (!opts.byStatus) return 0
    let rank = statusOf(unit)
    if (unit.kind === 'group') for (const n of doc.nodes) if (n.id !== unit.id && unitOf(n.id) === unit.id) rank = Math.min(rank, statusOf(n))
    return rank
  }
  const ranks = new Map(units.map((n) => [n.id, statusRank(n)]))
  const before = (a: CanvasNode, b: CanvasNode): number => ranks.get(a.id)! - ranks.get(b.id)! || order.get(a.id)! - order.get(b.id)!

  // Cables between units, and which units they join into clusters.
  const next = new Map<string, string[]>()
  const root = new Map(units.map((n) => [n.id, n.id]))
  const find = (id: string): string => {
    while (root.get(id) !== id) id = root.get(id)!
    return id
  }
  for (const [from, to] of links(doc)) {
    const a = unitOf(from)
    const b = unitOf(to)
    if (!a || !b || a === b) continue
    next.set(a, [...(next.get(a) ?? []), b])
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) root.set(order.get(ra)! < order.get(rb)! ? rb : ra, order.get(ra)! < order.get(rb)! ? ra : rb)
  }
  const clusters = new Map<string, CanvasNode[]>()
  for (const n of units) clusters.set(find(n.id), [...(clusters.get(find(n.id)) ?? []), n])
  const rankOf = (members: CanvasNode[]): number => Math.min(...members.map((n) => ranks.get(n.id)!))
  const ordered = [...clusters.values()].sort((a, b) => rankOf(a) - rankOf(b) || order.get(a[0].id)! - order.get(b[0].id)!)
  const packed = pack(
    ordered.map((members) => layoutCluster(members, next, before, gap)),
    opts.view,
    gap
  )

  // Where the result starts, in the parent's coordinates.
  const parent = parentId ? byId.get(parentId)! : null
  const others = doc.nodes.filter((n) => (n.parentId ?? null) === parentId && inProject(n, opts.projectId) && !unitIds.has(n.id))
  const placeAt = (origin: Point): Rect[] =>
    units.map((n) => ({ x: origin.x + packed.at.get(n.id)!.x, y: origin.y + packed.at.get(n.id)!.y, width: n.width, height: n.height }))
  const clear = (rects: Rect[]): boolean => rects.every((r) => others.every((o) => !overlaps(widen(r, gap - 1), o)))
  const corner = settled(units, packed.at) ?? { x: Math.min(...units.map((n) => n.x)), y: Math.min(...units.map((n) => n.y)) }
  let origin: Point
  if (scoped.scope.kind === 'group') origin = { x: GROUP_PAD, y: GROUP_TOP }
  else if (clear(placeAt(corner))) origin = corner
  else if (parent) origin = { x: GROUP_PAD, y: Math.max(GROUP_TOP, ...others.map((o) => bottom(o) + gap)) }
  else origin = placeNear(doc, { at: corner, size: { width: packed.width, height: packed.height }, projectId: opts.projectId, view: opts.view, gap, ignore: unitIds })

  const moves: TidyMove[] = []
  for (const n of units) {
    const p = packed.at.get(n.id)!
    const x = Math.round(origin.x + p.x)
    const y = Math.round(origin.y + p.y)
    if (x !== n.x || y !== n.y) moves.push({ id: n.id, x, y })
  }

  // A group that grows into a neighbour moves to the nearest free spot beside where it was.
  if (parent && !parent.parentId) {
    const fitted = reduce(doc, { op: 'moveNodes', moves }).nodes.find((n) => n.id === parent.id)!
    const was = absoluteRect(doc, parent)
    const now: Rect = { ...was, width: fitted.width, height: fitted.height }
    const neighbours = doc.nodes.filter((n) => !n.parentId && n.id !== parent.id && inProject(n, opts.projectId))
    if (neighbours.some((n) => overlaps(widen(now, gap - 1), n) && !overlaps(widen(was, gap - 1), n))) {
      const spot = placeNear(doc, { beside: was, size: { width: now.width, height: now.height }, projectId: opts.projectId, view: opts.view, gap, ignore: new Set([parent.id]) })
      if (spot.x !== parent.x || spot.y !== parent.y) moves.push({ id: parent.id, ...spot })
    }
  }

  return { scope: scoped.scope, parentId, units: units.map((n) => n.id), moves }
}

export function tidyOp(plan: TidyPlan): CanvasOp {
  return { op: 'moveNodes', moves: plan.moves }
}

/** Where each unit (and the group tidied) would be drawn once the plan is applied, in canvas coordinates. */
export function tidyResult(doc: CanvasDoc, plan: TidyPlan): { id: string; rect: Rect }[] {
  const after = reduce(doc, tidyOp(plan))
  const ids = plan.parentId ? [plan.parentId, ...plan.units] : plan.units
  return ids.flatMap((id) => {
    const n = after.nodes.find((node) => node.id === id)
    return n ? [{ id, rect: absoluteRect(after, n) }] : []
  })
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y }
}

/**
 * How far the view has to pan, in canvas units, to show what was tidied: nothing when it's in view already, only as
 * far as needed otherwise. Something bigger than the view is panned to just until the view is over it.
 */
export function panToShow(view: Rect, bounds: Rect): Point {
  const axis = (v0: number, vLen: number, b0: number, bLen: number): number => {
    if (bLen <= vLen) return b0 < v0 ? b0 - v0 : b0 + bLen > v0 + vLen ? b0 + bLen - (v0 + vLen) : 0
    return v0 < b0 ? b0 - v0 : v0 + vLen > b0 + bLen ? b0 + bLen - (v0 + vLen) : 0
  }
  return { x: axis(view.x, view.width, bounds.x, bounds.width), y: axis(view.y, view.height, bounds.y, bounds.height) }
}
