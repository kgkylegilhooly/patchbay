import type { WhiteboardShape } from './model'
import { BOARD_COLORS, LIMITS, shapeBox, textSize } from './whiteboard'

/**
 * A diagram an agent describes, as boxes and the arrows between them, laid out here as whiteboard shapes. Agents
 * say what's connected to what; where things go is worked out for them, so a sketch always comes out tidy.
 */
export interface DiagramSpec {
  title?: string
  /** Which way arrows mostly run. */
  direction?: 'right' | 'down'
  boxes: Array<{ id: string; label: string; color?: ColorName }>
  arrows?: Array<{ from: string; to: string; label?: string }>
}

const COLORS = { black: BOARD_COLORS[0], red: BOARD_COLORS[1], orange: BOARD_COLORS[2], green: BOARD_COLORS[3], blue: BOARD_COLORS[4], purple: BOARD_COLORS[5] }
type ColorName = keyof typeof COLORS

export const DIAGRAM_LIMITS = { boxes: 40, arrows: 80, label: 80, title: 120 }
const INK = 2
const LETTER = textSize(INK) * 0.56
const LINE = textSize(INK) * 1.25
const SMALL_LETTER = textSize(1) * 0.56
const SMALL_LINE = textSize(1) * 1.25
const PAD = { x: 18, y: 14 }
const GAP = { along: 90, across: 36 }
const MARGIN = 30

class DiagramError extends Error {}

/** Checks what an agent sent, saying exactly what's wrong so it can fix it. */
export function readDiagram(raw: unknown): DiagramSpec {
  const fail = (why: string): never => {
    throw new DiagramError(why)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('The diagram must be a JSON object with "boxes", and optionally "arrows", "title" and "direction".')
  const d = raw as Record<string, unknown>
  if (!Array.isArray(d.boxes) || !d.boxes.length) fail('"boxes" must be a list with at least one box, each {"id": "api", "label": "API"}.')
  const boxes = d.boxes as unknown[]
  if (boxes.length > DIAGRAM_LIMITS.boxes) fail(`A diagram can have up to ${DIAGRAM_LIMITS.boxes} boxes.`)
  const ids = new Set<string>()
  const outBoxes = boxes.map((b, i) => {
    const box = b as Record<string, unknown>
    if (typeof box !== 'object' || box === null || typeof box.id !== 'string' || !box.id) fail(`Box ${i + 1} needs an "id".`)
    if (ids.has(box.id as string)) fail(`Two boxes have the id "${box.id}".`)
    ids.add(box.id as string)
    const label = typeof box.label === 'string' && box.label.trim() ? box.label : (box.id as string)
    if (label.length > DIAGRAM_LIMITS.label) fail(`The label of box "${box.id}" is over ${DIAGRAM_LIMITS.label} characters.`)
    if (box.color !== undefined && !(typeof box.color === 'string' && box.color in COLORS)) fail(`Box "${box.id}" has an unknown color. Use one of: ${Object.keys(COLORS).join(', ')}.`)
    return { id: box.id as string, label, ...(box.color ? { color: box.color as ColorName } : {}) }
  })
  const arrows = d.arrows === undefined ? [] : d.arrows
  if (!Array.isArray(arrows)) fail('"arrows" must be a list, each {"from": "api", "to": "db"}.')
  if ((arrows as unknown[]).length > DIAGRAM_LIMITS.arrows) fail(`A diagram can have up to ${DIAGRAM_LIMITS.arrows} arrows.`)
  const outArrows = (arrows as unknown[]).map((a, i) => {
    const arrow = a as Record<string, unknown>
    if (typeof arrow !== 'object' || arrow === null || !ids.has(arrow.from as string) || !ids.has(arrow.to as string)) fail(`Arrow ${i + 1} must go "from" one box id "to" another.`)
    if (arrow.label !== undefined && (typeof arrow.label !== 'string' || arrow.label.length > DIAGRAM_LIMITS.label)) fail(`The label of arrow ${i + 1} must be text of up to ${DIAGRAM_LIMITS.label} characters.`)
    return { from: arrow.from as string, to: arrow.to as string, ...(arrow.label ? { label: arrow.label as string } : {}) }
  })
  if (d.title !== undefined && (typeof d.title !== 'string' || d.title.length > DIAGRAM_LIMITS.title)) fail(`"title" must be text of up to ${DIAGRAM_LIMITS.title} characters.`)
  if (d.direction !== undefined && d.direction !== 'right' && d.direction !== 'down') fail('"direction" must be "right" or "down".')
  return { boxes: outBoxes, arrows: outArrows, ...(d.title ? { title: d.title as string } : {}), ...(d.direction ? { direction: d.direction as 'right' | 'down' } : {}) }
}

export const isDiagramError = (e: unknown): e is Error => e instanceof DiagramError

/**
 * Each box's column: one past the furthest box with an arrow into it, so arrows run one way where they can. A cycle
 * can't push a box out forever, because no box goes further than there are boxes.
 */
function columns(spec: DiagramSpec): Map<string, number> {
  const level = new Map(spec.boxes.map((b) => [b.id, 0]))
  for (let pass = 0; pass < spec.boxes.length; pass++) {
    let moved = false
    for (const a of spec.arrows ?? []) {
      if (a.from === a.to) continue
      const want = Math.min(level.get(a.from)! + 1, spec.boxes.length - 1)
      if (want > level.get(a.to)!) {
        level.set(a.to, want)
        moved = true
      }
    }
    if (!moved) break
  }
  return level
}

/** Where a line from a box's center toward a point leaves the box. */
function edgeOf(box: { x: number; y: number; w: number; h: number }, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const scale = Math.min(dx ? box.w / 2 / Math.abs(dx) : Infinity, dy ? box.h / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/**
 * The diagram as shapes, placed below whatever is on the board already, so nothing drawn there is covered.
 */
export function layoutDiagram(spec: DiagramSpec, existing: WhiteboardShape[]): WhiteboardShape[] {
  const right = spec.direction !== 'down'
  const top = existing.length ? Math.max(...existing.map((s) => { const b = shapeBox(s); return b.y + b.height })) + 40 : MARGIN
  const shapes: WhiteboardShape[] = []
  let y0 = top
  if (spec.title) {
    shapes.push({ type: 'text', color: COLORS.black, size: 6, x: MARGIN, y: y0, text: spec.title })
    y0 += textSize(6) * 1.25 + 20
  }
  const level = columns(spec)
  const sized = spec.boxes.map((b) => {
    const lines = b.label.split('\n')
    return { ...b, lines, w: Math.max(110, Math.max(...lines.map((l) => l.length)) * LETTER + PAD.x * 2), h: lines.length * LINE + PAD.y * 2 }
  })
  const byLevel = new Map<number, typeof sized>()
  for (const b of sized) byLevel.set(level.get(b.id)!, [...(byLevel.get(level.get(b.id)!) ?? []), b])
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  // Room between columns for the longest arrow label, which sits above an arrow that runs across, or beside one that runs down.
  const labelWidth = Math.max(0, ...(spec.arrows ?? []).map((a) => (a.label ? a.label.length * SMALL_LETTER : 0)))
  const gapAlong = right ? Math.max(GAP.along, labelWidth + 40) : GAP.along
  // Each column is as wide as its widest box, or as tall as its tallest when it runs down.
  const along = levels.map((l) => Math.max(...byLevel.get(l)!.map((b) => (right ? b.w : b.h))))
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>()
  let at = 0
  levels.forEach((l, i) => {
    let across = 0
    for (const b of byLevel.get(l)!) {
      const box = right ? { x: MARGIN + at, y: y0 + across, w: b.w, h: b.h } : { x: MARGIN + across, y: y0 + at, w: b.w, h: b.h }
      placed.set(b.id, box)
      across += (right ? b.h : b.w) + GAP.across
    }
    at += along[i] + gapAlong
  })
  for (const b of sized) {
    const p = placed.get(b.id)!
    const color = COLORS[b.color ?? 'black']
    shapes.push({ type: 'rect', color, size: INK, x1: r1(p.x), y1: r1(p.y), x2: r1(p.x + p.w), y2: r1(p.y + p.h) })
    shapes.push({ type: 'text', color, size: INK, x: r1(p.x + PAD.x), y: r1(p.y + PAD.y), text: b.label })
  }
  for (const a of spec.arrows ?? []) {
    if (a.from === a.to) continue
    const from = placed.get(a.from)!
    const to = placed.get(a.to)!
    const start = edgeOf(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 })
    const end = edgeOf(to, { x: from.x + from.w / 2, y: from.y + from.h / 2 })
    shapes.push({ type: 'arrow', color: COLORS.black, size: INK, x1: r1(start.x), y1: r1(start.y), x2: r1(end.x), y2: r1(end.y) })
    if (a.label) {
      const midX = (start.x + end.x) / 2
      const midY = (start.y + end.y) / 2
      const width = a.label.length * SMALL_LETTER
      // Clear of the line: above one that runs across, to the right of one that runs down.
      const across = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
      const x = across ? midX - width / 2 : midX + 8
      const y = across ? midY - SMALL_LINE - 6 : midY - SMALL_LINE / 2
      shapes.push({ type: 'text', color: COLORS.blue, size: 1, x: r1(x), y: r1(y), text: a.label })
    }
  }
  if (existing.length + shapes.length > LIMITS.shapes) throw new DiagramError(`That would put more than ${LIMITS.shapes} shapes on the board. Clear some first.`)
  return shapes
}
