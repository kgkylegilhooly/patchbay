import { expect, test } from 'vitest'
import { arrangeNodes } from '../../src/core/canvas/arrange'
import type { CanvasNode, StickyNode } from '../../src/shared/model'

function node(id: string, width = 100, height = 100, x = 0, y = 0): StickyNode {
  return { id, title: id, x, y, width, height, parentId: null, kind: 'sticky', text: '' }
}
type Rect = { id: string; x: number; y: number; width: number; height: number }
function placed(nodes: CanvasNode[], layout: 'grid' | 'row' | 'column', gap?: number): Rect[] {
  return arrangeNodes(nodes, layout, gap).map((p) => {
    const n = nodes.find((x) => x.id === p.id)!
    return { id: p.id, x: p.x, y: p.y, width: n.width, height: n.height }
  })
}
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
function anyOverlap(rects: Rect[]): boolean {
  return rects.some((a, i) => rects.slice(i + 1).some((b) => overlaps(a, b)))
}

test('grid arrange of 4 equal nodes with gap 40 has no overlaps and 2 columns', () => {
  const rects = placed([node('a'), node('b'), node('c'), node('d')], 'grid', 40)
  expect(anyOverlap(rects)).toBe(false)
  expect(new Set(rects.map((r) => r.x)).size).toBe(2)
  expect(new Set(rects.map((r) => r.y)).size).toBe(2)
  const xs = [...new Set(rects.map((r) => r.x))].sort((p, q) => p - q)
  expect(xs[1] - xs[0]).toBe(140)
})

test('grid uses ceil(sqrt(n)) columns', () => {
  const rects = placed(['a', 'b', 'c', 'd', 'e'].map((i) => node(i)), 'grid')
  expect(new Set(rects.map((r) => r.x)).size).toBe(3)
})

test('grid of different sizes has no overlaps', () => {
  const rects = placed([node('a', 300, 50), node('b', 50, 400), node('c', 120, 120), node('d', 80, 500), node('e', 700, 20)], 'grid', 10)
  expect(anyOverlap(rects)).toBe(false)
})

test('row places nodes left to right using the default gap of 40', () => {
  const rects = placed([node('a', 100), node('b', 200), node('c', 50)], 'row')
  expect(rects.map((r) => r.x - rects[0].x)).toEqual([0, 140, 380])
  expect(new Set(rects.map((r) => r.y)).size).toBe(1)
})

test('column places nodes top to bottom', () => {
  const rects = placed([node('a', 100, 100), node('b', 100, 200)], 'column', 10)
  expect(rects.map((r) => r.y - rects[0].y)).toEqual([0, 110])
  expect(new Set(rects.map((r) => r.x)).size).toBe(1)
})

test('arrange starts at the top-left of the nodes it was given', () => {
  const [a, b] = arrangeNodes([node('a', 100, 100, 500, 700), node('b', 100, 100, 300, 900)], 'row')
  expect(a).toEqual({ id: 'a', x: 300, y: 700 })
  expect(b).toEqual({ id: 'b', x: 440, y: 700 })
})

test('arrange of nothing returns nothing', () => {
  expect(arrangeNodes([], 'grid')).toEqual([])
})
