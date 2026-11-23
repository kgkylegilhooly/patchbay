import { expect, test } from 'vitest'
import { createStager, edgesAmong, nearView } from '../../src/renderer/stagedFlow'
import type { FlowEdge, FlowNode } from '../../src/renderer/flowMapping'

const node = (id: string, x: number, y: number, extra: Partial<FlowNode> = {}): FlowNode =>
  ({ id, type: 'sticky', position: { x, y }, width: 300, height: 200, data: { node: { id } as never, status: null }, ...extra }) as FlowNode
const edge = (id: string, source: string, target: string): FlowEdge => ({ id, source, target, type: 'cable', data: { kind: 'link' } })
const view = { width: 1000, height: 800 }
const at = { x: 0, y: 0, zoom: 1 }

test('only the windows on or near the screen, in their order', () => {
  const nodes = [node('on', 100, 100), node('near', 1300, 100), node('far', 5000, 100), node('below', 100, 3000)]
  expect(nearView(nodes, at, view)?.map((n) => n.id)).toEqual(['on', 'near'])
})

test('the view and zoom place them: zoomed out, more is on screen', () => {
  const nodes = [node('a', 100, 100), node('b', 3000, 100)]
  expect(nearView(nodes, at, view)?.map((n) => n.id)).toEqual(['a'])
  expect(nearView(nodes, { x: 0, y: 0, zoom: 0.4 }, view)).toBeNull()
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

test('a switch draws the near part and asks for the rest; the next pass, or any change, draws it all', () => {
  const s = createStager()
  const flow = { nodes: [node('on', 0, 0), node('far', 9000, 0)], edges: [edge('e', 'on', 'far')] }
  // The first doc (start-up) counts as a switch too.
  const first = s.pick('p1', flow, at, view)
  expect(first.later).toBe(true)
  expect(first.nodes.map((n) => n.id)).toEqual(['on'])
  expect(first.edges).toEqual([])
  const rest = s.pick('p1', flow, at, view)
  expect(rest.later).toBe(false)
  expect(rest.nodes).toBe(flow.nodes)
  expect(rest.edges).toBe(flow.edges)
  // Another project: staged again. Without the view's size, everything at once.
  expect(s.pick('p2', flow, at, view).later).toBe(true)
  expect(s.pick('p3', flow, at, null).later).toBe(false)
})
