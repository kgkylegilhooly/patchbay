import { expect, test } from 'vitest'
import { ADOPT_SIZE, adoptSpot } from '../../src/main/sessions/adoptSpot'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

const viewport = { x: 0, y: 0, zoom: 1 }
const term = (id: string, x: number, y: number): CanvasNode => ({ id, kind: 'terminal', title: id, x, y, width: 560, height: 340, parentId: null, projectId: 'p', cwd: 'c' })
const docOf = (nodes: CanvasNode[]): CanvasDoc => ({ version: 3, projects: [{ id: 'p', name: 'P', folder: '', viewport }], activeProjectId: 'p', nodes, edges: [], closed: [], viewport })
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('a recovered session lands in a free spot in view, never on top of the sessions there', () => {
  // The old fixed spot, (120, 120) on screen, is taken; so is the middle of the view.
  const nodes = [term('a', 100, 100), term('b', 700, 300), term('c', 100, 500)]
  const view = { x: 0, y: 0, width: 1600, height: 1000 }
  const at = adoptSpot(docOf(nodes), view)
  const placed = { ...at, ...ADOPT_SIZE }
  for (const n of nodes) expect(overlaps(placed, n)).toBe(false)
})

test('with nothing known about the view, it still finds a free spot', () => {
  const nodes = [term('a', 80, 80)]
  const at = adoptSpot(docOf(nodes), null)
  expect(overlaps({ ...at, ...ADOPT_SIZE }, nodes[0])).toBe(false)
})
