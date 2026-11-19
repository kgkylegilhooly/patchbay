import type { CanvasDoc, CanvasNode, Viewport } from '../../shared/model'

/**
 * Where a new node goes. Every place that adds a node asks here, so they all agree: next to what it belongs to, in
 * view when the view is known, never on top of another node, and never moving anything that's already there.
 */

export interface Size {
  width: number
  height: number
}
export interface Point {
  x: number
  y: number
}
export interface Rect extends Point, Size {}

/** Between a new node and its neighbours, as a team's members are spaced. */
export const PLACE_GAP = 40
/** A group's inner padding and where its first child goes, below the header. Matches the reducer's fit. */
export const GROUP_PAD = 24
export const GROUP_TOP = 64
/** A group fills rows this many members wide, unless it's already wider. */
export const GROUP_COLUMNS = 2
/** Screen edges the canvas's own chrome covers, so a node there would be hidden. */
const VIEW_INSET = { left: 24, top: 24, right: 24, bottom: 84 }
/** Obstacles that give candidate spots. The rest still count as obstacles. */
const NEAREST = 24
/** A spot partly off screen loses to one this much further away that's fully on screen. */
const OFF_VIEW = 600
/** How much being out of line with the anchor counts against a spot, per pixel. */
const ALIGN = 0.5

const right = (r: Rect): number => r.x + r.width
const bottom = (r: Rect): number => r.y + r.height

export function absoluteRect(doc: Pick<CanvasDoc, 'nodes'>, node: CanvasNode): Rect {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  let { x, y } = node
  const seen = new Set([node.id])
  let parent = node.parentId ? byId.get(node.parentId) : undefined
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id)
    x += parent.x
    y += parent.y
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return { x, y, width: node.width, height: node.height }
}

/** The project a node is in. A node without one belongs to the project on screen, as everywhere else. */
export function projectOf(doc: Pick<CanvasDoc, 'activeProjectId'>, node: { projectId?: string }): string {
  return node.projectId ?? doc.activeProjectId
}

/**
 * The part of a project's canvas a window of this size shows, in canvas coordinates, less the edges the sidebar and
 * dock may cover. Null when the size isn't known.
 */
export function viewRect(doc: Pick<CanvasDoc, 'activeProjectId' | 'viewport' | 'projects'>, projectId: string, screen: Size | null | undefined): Rect | null {
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return null
  const vp: Viewport | undefined = projectId === doc.activeProjectId ? doc.viewport : doc.projects.find((p) => p.id === projectId)?.viewport
  if (!vp || !(vp.zoom > 0)) return null
  return {
    x: (VIEW_INSET.left - vp.x) / vp.zoom,
    y: (VIEW_INSET.top - vp.y) / vp.zoom,
    width: Math.max(0, screen.width - VIEW_INSET.left - VIEW_INSET.right) / vp.zoom,
    height: Math.max(0, screen.height - VIEW_INSET.top - VIEW_INSET.bottom) / vp.zoom
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)
}

/** How far outside the view a box reaches, summed over its sides. 0 when it's fully inside. */
function overflow(r: Rect, view: Rect): number {
  return Math.max(0, view.x - r.x) + Math.max(0, right(r) - right(view)) + Math.max(0, view.y - r.y) + Math.max(0, bottom(r) - bottom(view))
}

/** The empty gap between two boxes along each axis. */
function apart(a: Rect, b: Rect): { dx: number; dy: number } {
  return { dx: Math.max(0, a.x - right(b), b.x - right(a)), dy: Math.max(0, a.y - bottom(b), b.y - bottom(a)) }
}

export type PlaceRequest = {
  size: Size
  projectId: string
  /** The canvas the person sees, when known. Spots inside it are preferred, if the anchor is in it too. */
  view?: Rect | null
  gap?: number
  /** Nodes that don't count as obstacles, such as ones being placed together. */
  ignore?: ReadonlySet<string>
} & (
  | {
      /** The box the new node belongs next to: the node that opened it, or the selected one. */
      beside: Rect
    }
  | {
      /** Where its top-left corner should go if that's free, such as where the person clicked. */
      at: Point
    }
)

/** The top-level boxes of one project, which a new top-level node must keep clear of. */
export function obstacles(doc: Pick<CanvasDoc, 'nodes' | 'activeProjectId'>, projectId: string, ignore?: ReadonlySet<string>): Rect[] {
  return doc.nodes
    .filter((n) => !n.parentId && projectOf(doc, n) === projectId && !ignore?.has(n.id))
    .map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
}

/**
 * The nearest free spot for a new top-level node. Spots are tried around the anchor and around the nodes near it,
 * nearest first: beside it on the right, then below, left and above, then further out. A spot keeps the gap from
 * every other top-level node and group in the project, so nothing is covered and nothing moves.
 */
export function placeNear(doc: Pick<CanvasDoc, 'nodes' | 'activeProjectId'>, req: PlaceRequest): Point {
  const gap = req.gap ?? PLACE_GAP
  const { width: w, height: h } = req.size
  const boxes = obstacles(doc, req.projectId, req.ignore)
  const anchor: Rect = 'beside' in req ? req.beside : { ...req.at, width: w, height: h }
  const view = req.view && overlaps(anchor, req.view) ? req.view : null

  const xs = new Set<number>()
  const ys = new Set<number>()
  const around = (r: Rect): void => {
    xs.add(right(r) + gap).add(r.x).add(r.x - gap - w)
    ys.add(bottom(r) + gap).add(r.y).add(r.y - gap - h)
  }
  if ('at' in req) {
    xs.add(req.at.x)
    ys.add(req.at.y)
  }
  around(anchor)
  const near = [...boxes].sort((a, b) => edgeDistance(a, anchor) - edgeDistance(b, anchor)).slice(0, NEAREST)
  for (const b of near) around(b)
  if (boxes.length) {
    // Past everything: always free, so there is always an answer.
    xs.add(Math.max(...boxes.map(right)) + gap).add(Math.min(...boxes.map((b) => b.x)) - gap - w)
    ys.add(Math.max(...boxes.map(bottom)) + gap).add(Math.min(...boxes.map((b) => b.y)) - gap - h)
  }
  if (view) {
    xs.add(view.x).add(right(view) - w)
    ys.add(view.y).add(bottom(view) - h)
  }

  const score = (c: Rect): number => {
    let s: number
    if ('at' in req) s = Math.hypot(c.x - req.at.x, c.y - req.at.y)
    else {
      const { dx, dy } = apart(c, anchor)
      // In line with the anchor reads as belonging to it: level with it beside, or under its left edge. A corner spot
      // counts the smaller of its two shifts, so a free corner next to the anchor beats going far round.
      const offset =
        dx > 0 && dy === 0 ? Math.abs(c.y - anchor.y) : dy > 0 && dx === 0 ? Math.abs(c.x - anchor.x) : Math.min(Math.abs(c.x - anchor.x), Math.abs(c.y - anchor.y))
      s = Math.hypot(dx, dy) + offset * ALIGN + side(c, anchor) * 0.01
    }
    return view ? s + (overflow(c, view) > 0 ? OFF_VIEW + overflow(c, view) : 0) : s
  }
  const clear = (c: Rect): boolean =>
    boxes.every((b) => c.x >= right(b) + gap || b.x >= right(c) + gap || c.y >= bottom(b) + gap || b.y >= bottom(c) + gap)

  const candidates: { c: Rect; s: number }[] = []
  for (const x of xs) for (const y of ys) {
    const c = { x, y, width: w, height: h }
    candidates.push({ c, s: score(c) })
  }
  candidates.sort((a, b) => a.s - b.s)
  const found = candidates.find(({ c }) => clear(c))?.c ?? { x: anchor.x, y: anchor.y }
  return { x: Math.round(found.x), y: Math.round(found.y) }
}

function edgeDistance(a: Rect, b: Rect): number {
  const { dx, dy } = apart(a, b)
  return Math.hypot(dx, dy)
}

/** Which side of the anchor a spot is on, in the order they're preferred: right, below, left, above, corners. */
function side(c: Rect, anchor: Rect): number {
  const { dx, dy } = apart(c, anchor)
  if (dx > 0 && dy === 0) return c.x >= right(anchor) ? 0 : 2
  if (dy > 0 && dx === 0) return c.y >= bottom(anchor) ? 1 : 3
  return 4
}

/**
 * Where a new member goes inside a group, relative to the group: the first free cell reading across rows, left to
 * right, as wide as the group already is or GROUP_COLUMNS members, whichever is wider. The group grows to fit it
 * (the reducer does that), and nothing already inside moves.
 */
export function placeInGroup(doc: Pick<CanvasDoc, 'nodes'>, groupId: string, size: Size, gap = PLACE_GAP): Point {
  const group = doc.nodes.find((n) => n.id === groupId)
  const kids: Rect[] = doc.nodes.filter((n) => n.parentId === groupId).map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
  if (!group || kids.length === 0) return { x: GROUP_PAD, y: GROUP_TOP }
  const cell = Math.max(size.width, ...kids.map((k) => k.width))
  const limit = GROUP_PAD + Math.max(group.width - 2 * GROUP_PAD, GROUP_COLUMNS * (cell + gap) - gap, Math.max(...kids.map(right)) - GROUP_PAD)
  const xs = new Set<number>([GROUP_PAD, ...kids.map((k) => right(k) + gap), ...kids.map((k) => k.x)])
  const ys = new Set<number>([GROUP_TOP, ...kids.map((k) => bottom(k) + gap), ...kids.map((k) => k.y)])
  const clear = (c: Rect): boolean =>
    kids.every((k) => c.x >= right(k) + gap || k.x >= right(c) + gap || c.y >= bottom(k) + gap || k.y >= bottom(c) + gap)
  const spots = [...ys]
    .filter((y) => y >= GROUP_TOP)
    .sort((a, b) => a - b)
    .flatMap((y) => [...xs].filter((x) => x >= GROUP_PAD && x + size.width <= limit).sort((a, b) => a - b).map((x) => ({ x, y, ...size })))
  // Below everything at the left edge is always free.
  const found = spots.find(clear) ?? { x: GROUP_PAD, y: Math.max(...kids.map(bottom)) + gap }
  return { x: Math.round(found.x), y: Math.round(found.y) }
}

/**
 * For a node nothing on the canvas opened: the middle of the view when it's known, otherwise just inside the view's
 * top-left corner, and the nearest free spot to that.
 */
export function placeInProject(doc: Pick<CanvasDoc, 'nodes' | 'activeProjectId' | 'viewport' | 'projects'>, projectId: string, size: Size, screen?: Size | null): Point {
  const view = viewRect(doc, projectId, screen)
  if (view) return placeNear(doc, { at: { x: view.x + (view.width - size.width) / 2, y: view.y + (view.height - size.height) / 2 }, size, projectId, view })
  const vp = projectId === doc.activeProjectId ? doc.viewport : doc.projects.find((p) => p.id === projectId)?.viewport
  const zoom = vp && vp.zoom > 0 ? vp.zoom : 1
  const at = vp ? { x: (80 - vp.x) / zoom, y: (80 - vp.y) / zoom } : { x: 0, y: 0 }
  return placeNear(doc, { at, size, projectId })
}
