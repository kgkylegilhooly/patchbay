import { expect, test } from 'vitest'
import { shallow } from 'zustand/shallow'
import { latestTeamMessage, memberStatuses } from '../../src/renderer/teamSelect'
import { teamStatus } from '../../src/renderer/teamStatus'
import type { NodeMessage } from '../../src/shared/contract'
import type { AgentStatus, CanvasNode } from '../../src/shared/model'

const at = { x: 0, y: 0, width: 1, height: 1 }
const agent = (id: string, parentId: string | null): CanvasNode => ({ ...at, id, kind: 'claude', title: id, parentId, cwd: 'c', sessionId: null, transcriptPath: null, after: [] })
const nodes: CanvasNode[] = [
  { ...at, id: 'g', kind: 'group', title: 'Team', parentId: null, worktree: null },
  { ...at, id: 'h', kind: 'group', title: 'Other', parentId: null, worktree: null },
  agent('a', 'g'),
  agent('b', 'g'),
  agent('x', 'h'),
  agent('lead', null),
  { ...at, id: 't', kind: 'terminal', title: 'Shell', parentId: 'g', cwd: 'c' }
]
const m = (from: string, to: string, n: number): NodeMessage => ({ from, to, text: `${from}${n}`, at: n })

test("a group reads only its own agents' statuses", () => {
  expect(memberStatuses(nodes, { a: 'working', x: 'idle', lead: 'working', t: 'working' }, 'g')).toEqual({ a: 'working' })
  expect(memberStatuses(undefined, { a: 'working' }, 'g')).toEqual({})
})

test("a status change in another group gives the same members' statuses, so the group doesn't render", () => {
  const before: Record<string, AgentStatus> = { a: 'working', b: 'idle', x: 'working' }
  const after = { ...before, x: 'needs-you' as const }
  expect(shallow(memberStatuses(nodes, before, 'g'), memberStatuses(nodes, after, 'g'))).toBe(true)
  expect(shallow(memberStatuses(nodes, before, 'g'), memberStatuses(nodes, { ...before, b: 'working' }, 'g'))).toBe(false)
})

test("the latest message to or from a member is the same object until one of the team's arrives", () => {
  const theirs = m('lead', 'b', 2)
  const messages = [m('a', 'lead', 1), theirs, m('lead', 'x', 3)]
  expect(latestTeamMessage(nodes, messages, 'g')).toBe(theirs)
  expect(latestTeamMessage(nodes, [...messages, m('x', 'lead', 4)], 'g')).toBe(theirs)
  expect(latestTeamMessage(nodes, messages, 'nobody')).toBeNull()
  expect(latestTeamMessage(nodes, [], 'g')).toBeNull()
})

test('the narrowed inputs give the team line it had from the whole canvas', () => {
  const statuses: Record<string, AgentStatus> = { a: 'needs-you', b: 'working', x: 'idle', lead: 'working' }
  const messages = [m('a', 'lead', 1), m('lead', 'b', 2), m('lead', 'x', 3)]
  const latest = latestTeamMessage(nodes, messages, 'g')
  const narrowed = teamStatus(nodes, memberStatuses(nodes, statuses, 'g'), latest ? [latest] : [], 'g', {}, 1000)
  expect(narrowed).toEqual(teamStatus(nodes, statuses, messages, 'g', {}, 1000))
})
