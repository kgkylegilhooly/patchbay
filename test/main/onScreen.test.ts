import { expect, test } from 'vitest'
import { onScreenIds } from '../../src/main/onScreen'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

const node = (id: string, projectId?: string): CanvasNode =>
  ({ kind: 'terminal', id, title: id, x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: '.', ...(projectId ? { projectId } : {}) }) as CanvasNode

test('the project on screen, and nodes with no project, are on screen; other projects are not', () => {
  const doc = {
    version: 3,
    projects: [],
    activeProjectId: 'p1',
    nodes: [node('a', 'p1'), node('b', 'p2'), node('loose')],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  } as unknown as CanvasDoc
  expect([...onScreenIds(doc)].sort()).toEqual(['a', 'loose'])
  // It goes with whichever project is on screen.
  expect([...onScreenIds({ ...doc, activeProjectId: 'p2' })].sort()).toEqual(['b', 'loose'])
})
