import { expect, test } from 'vitest'
import { selectedAgents } from '../../src/renderer/sendToAgents'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

const box = { x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p' }
const agent = (id: string, parentId: string | null = null): CanvasNode => ({ ...box, id, title: `Agent ${id}`, kind: 'claude', cwd: 'C:\\a', sessionId: null, transcriptPath: null, after: [], parentId })
const doc = (nodes: CanvasNode[]): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  nodes,
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

test('the agents among the selection, and inside selected groups, once each, in canvas order', () => {
  const team = { ...box, id: 'team', title: 'Team', kind: 'group', worktree: null } as CanvasNode
  const inner = { ...box, id: 'inner', title: 'Inner', kind: 'group', worktree: null, parentId: 'team' } as CanvasNode
  const shell = { ...box, id: 'sh', title: 'Shell', kind: 'terminal', cwd: 'C:\\a' } as CanvasNode
  const d = doc([agent('a'), team, agent('b', 'team'), inner, agent('c', 'inner'), shell, agent('d')])
  expect(selectedAgents(d, ['d', 'team', 'sh', 'b']).map((a) => a.id)).toEqual(['b', 'c', 'd'])
  expect(selectedAgents(d, ['sh'])).toEqual([])
})
