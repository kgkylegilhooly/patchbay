import { expect, test } from 'vitest'
import { bucketOf } from '../../src/renderer/sidebarView'
import { teamStatus } from '../../src/renderer/teamStatus'
import type { AgentStop } from '../../src/shared/agentStop'
import type { ClaudeNode } from '../../src/shared/model'

const member = (id: string): ClaudeNode => ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 1, height: 1, parentId: 'g', cwd: '', sessionId: null, transcriptPath: null, after: [] })

test('an agent stopped on an API error goes under Need attention, not Unknown; the stop only counts while unknown', () => {
  expect(bucketOf('claude', 'unknown', false, true)).toBe('needs-you')
  expect(bucketOf('claude', 'unknown', false, false)).toBe('unknown')
  expect(bucketOf('claude', 'working', false, true)).toBe('running')
})

test("a team's summary counts stopped members apart from unknown ones", () => {
  const nodes = [member('a'), member('b'), member('c')]
  const statuses = { a: 'unknown', b: 'unknown', c: 'working' } as const
  const now = Date.parse('2026-11-20T12:00:00')
  const login: AgentStop = { kind: 'auth', at: now, until: null, message: null, holds: 'person' }
  const limit: AgentStop = { kind: 'usage-limit', at: now, until: now + 3600_000, message: null, holds: 'reset' }
  expect(teamStatus(nodes, statuses, [], 'g').summary).toBe('1 working, 2 no status yet')
  const team = teamStatus(nodes, statuses, [], 'g', { a: login, b: limit }, now)
  expect(team.summary).toBe('1 stopped, 1 working, 1 at a limit')
  // The lights: the held one red-ringed and first, the one at a limit amber-ringed after the working one.
  expect(team.members.map((m) => [m.id, m.look.tone, m.look.label])).toEqual([['a', 'held', 'Login failed'], ['c', 'working', 'Working'], ['b', 'waits', 'Usage limit until 13:00']])
})
