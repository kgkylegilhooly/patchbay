import type { WhiteboardShape } from './model'

/**
 * Whiteboard drawings as SVG. The board on screen and the picture an agent exports are both built here, so they
 * can't differ. Shapes are in board pixels from the drawing area's top left.
 */

export const BOARD_PAPER = '#fbfbf8'
/** The board's header and toolbar, its border and the margin round the paper, which the drawing area is the rest of. */
const CHROME = { width: 14, height: 84 }

/** The size of the paper inside a board node of this size. */
export function boardArea(node: { width: number; height: number }): { width: number; height: number } {
  return { width: Math.max(1, Math.round(node.width - CHROME.width)), height: Math.max(1, Math.round(node.height - CHROME.height)) }
}

/** The first is the default pen. */
export const BOARD_COLORS = ['#1f1f22', '#d64545', '#e8862f', '#2f9e5b', '#2f6fd6', '#8a4fd6']
export const BOARD_SIZES = [2, 4, 8]
export const LIMITS = { shapes: 2000, points: 4000, text: 500, coord: 100000 }

const HEX = /^#[0-9a-f]{3,8}$/i
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.coord

/** Whether a saved shape is one this can draw. Anything else in a save file is refused, like any bad node. */
export function isWhiteboardShape(v: unknown): v is WhiteboardShape {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  if (typeof s.color !== 'string' || !HEX.test(s.color) || !isNum(s.size) || s.size <= 0 || s.size > 200) return false
  switch (s.type) {
    case 'pen':
      return Array.isArray(s.points) && s.points.length >= 2 && s.points.length % 2 === 0 && s.points.length <= LIMITS.points * 2 && s.points.every(isNum)
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return isNum(s.x1) && isNum(s.y1) && isNum(s.x2) && isNum(s.y2)
    case 'text':
      return isNum(s.x) && isNum(s.y) && typeof s.text === 'string' && s.text.length > 0 && s.text.length <= LIMITS.text
    default:
      return false
  }
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/** Drops points too close to the last one kept, so a slow stroke doesn't save thousands of them. */
export function thinPoints(points: number[], min = 1.5): number[] {
  if (points.length <= 4) return points.map(r1)
  const out = [r1(points[0]), r1(points[1])]
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - out[out.length - 2]
    const dy = points[i + 1] - out[out.length - 1]
    if (dx * dx + dy * dy >= min * min) out.push(r1(points[i]), r1(points[i + 1]))
  }
  out.push(r1(points[points.length - 2]), r1(points[points.length - 1]))
  return out.slice(0, LIMITS.points * 2)
}

/** A smooth path through a stroke's points, curving through the midpoints between them. */
export function penPath(points: number[]): string {
  const n = points.length / 2
  if (n === 1) return `M${points[0]} ${points[1]}l0.01 0`
  let d = `M${points[0]} ${points[1]}`
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2]
    const y = points[i * 2 + 1]
    const mx = r1((x + points[i * 2 + 2]) / 2)
    const my = r1((y + points[i * 2 + 3]) / 2)
    d += `Q${x} ${y} ${mx} ${my}`
  }
  return `${d}L${points[n * 2 - 2]} ${points[n * 2 - 1]}`
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** How tall a line of text is for its size, which is the stroke size it was typed with. */
export const textSize = (size: number): number => 12 + size * 2.5
const FONT = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"

/** One shape as SVG markup. The color has been checked, and text is escaped. */
export function shapeSvg(s: WhiteboardShape): string {
  const color = HEX.test(s.color) ? s.color : BOARD_COLORS[0]
  const stroke = `stroke="${color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round" fill="none"`
  switch (s.type) {
    case 'pen':
      return `<path d="${penPath(s.points)}" ${stroke}/>`
    case 'line':
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" ${stroke}/>`
    case 'arrow': {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
      const head = 8 + s.size * 2.5
      const wing = (side: number): string => `${r1(s.x2 - head * Math.cos(angle + side))} ${r1(s.y2 - head * Math.sin(angle + side))}`
      return `<path d="M${s.x1} ${s.y1}L${s.x2} ${s.y2}M${wing(0.45)}L${s.x2} ${s.y2}L${wing(-0.45)}" ${stroke}/>`
    }
    case 'rect':
      return `<rect x="${Math.min(s.x1, s.x2)}" y="${Math.min(s.y1, s.y2)}" width="${Math.abs(s.x2 - s.x1)}" height="${Math.abs(s.y2 - s.y1)}" rx="3" ${stroke}/>`
    case 'ellipse':
      return `<ellipse cx="${r1((s.x1 + s.x2) / 2)}" cy="${r1((s.y1 + s.y2) / 2)}" rx="${r1(Math.abs(s.x2 - s.x1) / 2)}" ry="${r1(Math.abs(s.y2 - s.y1) / 2)}" ${stroke}/>`
    case 'text': {
      const size = textSize(s.size)
      const lines = s.text.split('\n')
      const spans = lines.map((line, i) => `<tspan x="${s.x}" dy="${i ? r1(size * 1.25) : 0}">${escapeXml(line) || ' '}</tspan>`).join('')
      return `<text x="${s.x}" y="${s.y}" font-size="${size}" font-family="${FONT}" fill="${color}" dominant-baseline="hanging">${spans}</text>`
    }
  }
}

export function shapesSvg(shapes: WhiteboardShape[]): string {
  return shapes.map(shapeSvg).join('')
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Roughly where a shape's ink is, stroke included. Text is measured by an average letter width. */
export function shapeBox(s: WhiteboardShape): Box {
  const pad = s.size / 2 + 1
  let xs: number[]
  let ys: number[]
  if (s.type === 'pen') {
    xs = s.points.filter((_, i) => i % 2 === 0)
    ys = s.points.filter((_, i) => i % 2 === 1)
  } else if (s.type === 'text') {
    const size = textSize(s.size)
    const lines = s.text.split('\n')
    xs = [s.x, s.x + Math.max(...lines.map((l) => l.length)) * size * 0.58]
    ys = [s.y, s.y + lines.length * size * 1.25]
  } else {
    xs = [s.x1, s.x2]
    ys = [s.y1, s.y2]
  }
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y }
}

/** What an export shows: the board as it's sized on the canvas, grown to take in anything drawn past its edges. */
export function exportBox(shapes: WhiteboardShape[], width: number, height: number): Box {
  let x0 = 0
  let y0 = 0
  let x1 = width
  let y1 = height
  for (const s of shapes) {
    const b = shapeBox(s)
    x0 = Math.min(x0, b.x - 8)
    y0 = Math.min(y0, b.y - 8)
    x1 = Math.max(x1, b.x + b.width + 8)
    y1 = Math.max(y1, b.y + b.height + 8)
  }
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - Math.floor(x0)), height: Math.ceil(y1 - Math.floor(y0)) }
}

/** The whole board as a standalone SVG file, paper included. */
export function whiteboardSvg(shapes: WhiteboardShape[], width: number, height: number): { svg: string; width: number; height: number } {
  const b = exportBox(shapes, width, height)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${b.width}" height="${b.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}">` +
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${BOARD_PAPER}"/>${shapesSvg(shapes)}</svg>`
  return { svg, width: b.width, height: b.height }
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Whether the eraser, a circle at x, y, touches a shape's ink. */
export function touches(s: WhiteboardShape, x: number, y: number, radius: number): boolean {
  const reach = radius + s.size / 2
  switch (s.type) {
    case 'pen': {
      const p = s.points
      if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach
      for (let i = 0; i < p.length - 2; i += 2) if (segmentDistance(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true
      return false
    }
    case 'line':
    case 'arrow':
      return segmentDistance(x, y, s.x1, s.y1, s.x2, s.y2) <= reach
    case 'rect': {
      const corners = [s.x1, s.y1, s.x2, s.y1, s.x2, s.y2, s.x1, s.y2, s.x1, s.y1]
      for (let i = 0; i < 8; i += 2) if (segmentDistance(x, y, corners[i], corners[i + 1], corners[i + 2], corners[i + 3]) <= reach) return true
      return false
    }
    case 'ellipse': {
      const cx = (s.x1 + s.x2) / 2
      const cy = (s.y1 + s.y2) / 2
      const rx = Math.abs(s.x2 - s.x1) / 2
      const ry = Math.abs(s.y2 - s.y1) / 2
      let last: [number, number] = [cx + rx, cy]
      for (let i = 1; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2
        const next: [number, number] = [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
        if (segmentDistance(x, y, last[0], last[1], next[0], next[1]) <= reach) return true
        last = next
      }
      return false
    }
    case 'text': {
      const b = shapeBox(s)
      return x >= b.x - radius && x <= b.x + b.width + radius && y >= b.y - radius && y <= b.y + b.height + radius
    }
  }
}

/** A plain account of a board for an agent: what's on it, and the words written on it. */
export function describeBoard(shapes: WhiteboardShape[]): { shapes: Record<string, number>; texts: string[] } {
  const counts: Record<string, number> = {}
  for (const s of shapes) counts[s.type] = (counts[s.type] ?? 0) + 1
  return { shapes: counts, texts: shapes.flatMap((s) => (s.type === 'text' ? [s.text] : [])) }
}
