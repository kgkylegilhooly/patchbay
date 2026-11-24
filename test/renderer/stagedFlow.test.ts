import { expect, test } from 'vitest'
import { BATCH, createStager, edgesAmong, nearView } from '../../src/renderer/stagedFlow'
import type { FlowEdge, FlowNode } from '../../src/renderer/flowMapping'

const node = (id: string, x: number, y: number, extra: Partial<FlowNode> = {}): FlowNode =>
  ({ id, type: 'sticky', position: { x, y }, width: 300, height: 200, data: { node: { id } as never, status: null }, ...extra }) as FlowNode
const edge = (id: string, source: string, target: string): FlowEdge => ({ id, source, target, type: 'cable', data: { kind: 'link' } })
const view = { width: 1000, height: 800 }
const at = { x: 0, y: 0, zoom: 1 }

test('only the windows on or touching the screen, in their order', () => {
  // edge pokes 10 px into the view from the right; past is wholly beyond it, by 10 px.
  const nodes = [node('on', 100, 100), node('edge', 990, 100), node('past', 1010, 100), node('far', 5000, 100), node('below', 100, 3000), node('above', 100, -210)]
  expect(nearView(nodes, at, view)?.map((n) => n.id)).toEqual(['on', 'edge'])
})

test('the view and zoom place them: zoomed out, more is on screen', () => {
  const nodes = [node('a', 100, 100), node('b', 3000, 100)]
  expect(nearView(nodes, at, view)?.map((n) => n.id)).toEqual(['a'])
  expect(nearView(nodes, { x: 0, y: 0, zoom: 0.3 }, view)).toBeNull()
  // Panned so b is on screen and a off it.
  expect(nearView(nodes, { x: -2800, y: 0, zoom: 1 }, view)?.map((n) => n.id)).toEqual(['b'])
})

test("a child's place is its parent's plus its own, and a drawn child brings its parent", () => {
  const group = node('g', 4000, 0, { type: 'group', width: 3000, height: 1000 })
  const child = node('c', -3900, 100, { parentId: 'g' })
  const lost = node('d', 100, 100, { parentId: 'g' })
  const nodes = [group, child, lost, node('far', 9000, 9000)]
  // c is at 100,100 on the canvas: on screen, so g comes too; d is at 4100,100: off.
  expect(nearView(nodes, at, view)?.map((n) => n.id)).toEqual(['g', 'c'])
})

test('nothing held back when all are near, or none is', () => {
  expect(nearView([node('a', 0, 0), node('b', 400, 0)], at, view)).toBeNull()
  expect(nearView([node('a', 9000, 0)], at, view)).toBeNull()
  expect(nearView([], at, view)).toBeNull()
})

test('cables only between drawn windows', () => {
  const nodes = [node('a', 0, 0), node('b', 0, 0)]
  expect(edgesAmong([edge('ab', 'a', 'b'), edge('ac', 'a', 'c')], nodes).map((e) => e.id)).toEqual(['ab'])
})

test('a switch draws what is on screen and asks for the rest; once that frame is drawn the rest comes', () => {
  const s = createStager()
  const flow = { nodes: [node('on', 0, 0), node('far', 9000, 0)], edges: [edge('e', 'on', 'far')] }
  // The first doc (start-up) counts as a switch too.
  const first = s.pick('p1', flow, at, view)
  expect(first.later).toBe(true)
  expect(first.nodes.map((n) => n.id)).toEqual(['on'])
  expect(first.edges).toEqual([])
  s.advance()
  const rest = s.pick('p1', flow, at, view)
  expect(rest.later).toBe(false)
  expect(rest.nodes).toBe(flow.nodes)
  expect(rest.edges).toBe(flow.edges)
  // Another project: staged again. Without the view's size, everything at once.
  expect(s.pick('p2', flow, at, view).later).toBe(true)
  expect(s.pick('p3', flow, at, null).later).toBe(false)
})

test('the rest comes a batch a frame, nearest the view first, each with its group', () => {
  const s = createStager()
  // 20 off screen to the right, further and further; f7 sits in a group placed further still.
  const off = Array.from({ length: 20 }, (_, i) => node(`f${i}`, 1100 + i * 400, 0))
  const group = node('g', 50_000, 0, { type: 'group', width: 3000, height: 1000 })
  off[7] = node('f7', 1100 + 7 * 400 - 50_000, 0, { parentId: 'g' })
  const flow = { nodes: [node('on', 0, 0), group, ...off], edges: [] }
  expect(s.pick('p1', flow, at, view).nodes.map((n) => n.id)).toEqual(['on'])
  s.advance()
  const second = s.pick('p1', flow, at, view)
  expect(second.later).toBe(true)
  // The nearest BATCH (8): f0..f7, and f7 brings its group.
  expect(second.nodes.map((n) => n.id)).toEqual(['on', 'g', ...off.slice(0, BATCH).map((n) => n.id)])
  s.advance()
  expect(s.pick('p1', flow, at, view).nodes).toHaveLength(2 + 2 * BATCH)
  s.advance()
  const done = s.pick('p1', flow, at, view)
  expect(done.later).toBe(false)
  expect(done.nodes).toBe(flow.nodes)
})

test('a change while staging keeps what is drawn, without drawing it all at once; a new window shows at once', () => {
  const s = createStager()
  const off = Array.from({ length: 20 }, (_, i) => node(`f${i}`, 1100 + i * 400, 0))
  const flow = { nodes: [node('on', 0, 0), ...off], edges: [] }
  s.pick('p1', flow, at, view)
  // A status change: a new flow, no frame drawn yet.
  const again = s.pick('p1', { ...flow, nodes: [...flow.nodes] }, at, view)
  expect(again.later).toBe(true)
  expect(again.nodes.map((n) => n.id)).toEqual(['on'])
  // A window opened meanwhile, off screen: it wasn't in the project at the switch, so it's drawn now.
  const opened = s.pick('p1', { ...flow, nodes: [...flow.nodes, node('new', 9000, 9000)] }, at, view)
  expect(opened.nodes.map((n) => n.id)).toEqual(['on', 'new'])
  // advance() outside a staged switch does nothing.
  const t = createStager()
  t.advance()
  expect(t.pick('p1', { nodes: [node('a', 0, 0)], edges: [] }, at, view).later).toBe(false)
})
