import { expect, test } from 'vitest'
import { teamStatus } from '../../src/renderer/teamStatus'
import type { CanvasNode } from '../../src/shared/model'

const at = { x: 0, y: 0, width: 1, height: 1 }
const agent = (id: string, parentId: string | null): CanvasNode => ({ ...at, id, kind: 'claude', title: id.toUpperCase(), parentId, cwd: 'c', sessionId: null, transcriptPath: null, after: [] })
const nodes: CanvasNode[] = [
  { ...at, id: 'g', kind: 'group', title: 'Team', parentId: null, worktree: null },
  agent('a', 'g'),
  agent('b', 'g'),
  agent('c', 'g'),
  agent('lead', null),
  { ...at, id: 't', kind: 'terminal', title: 'Shell', parentId: 'g', cwd: 'c' }
]

test('lists a group\'s agents, most pressing first, and counts them in words', () => {
  const team = teamStatus(nodes, { a: 'working', b: 'needs-you', c: 'working' }, [], 'g')
  expect(team.members.map((m) => [m.id, m.status])).toEqual([['b', 'needs-you'], ['a', 'working'], ['c', 'working']])
  expect(team.summary).toBe('1 needs you, 2 working')
  expect(team.latest).toBeNull()
  expect(team.members.map((m) => m.look.tone)).toEqual(['needs', 'working', 'working'])
})

test('an agent with no status yet says so, and a group with no agents has nothing to say', () => {
  expect(teamStatus(nodes, { a: 'idle' }, [], 'g').summary).toBe('1 idle, 2 no status yet')
  expect(teamStatus(nodes, {}, [], 'other')).toEqual({ members: [], summary: '', latest: null })
})

test('the latest message is the newest one to or from a member', () => {
  const m = (from: string, to: string, at: number) => ({ from, to, text: `${from}${at}`, at })
  expect(teamStatus(nodes, {}, [m('a', 'lead', 1), m('lead', 'b', 2), m('lead', 'x', 3)], 'g').latest?.text).toBe('lead2')
})
