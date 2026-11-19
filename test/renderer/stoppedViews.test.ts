import { expect, test } from 'vitest'
import { bucketOf } from '../../src/renderer/sidebarView'
import { teamStatus } from '../../src/renderer/teamStatus'
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
  expect(teamStatus(nodes, statuses, [], 'g').summary).toBe('1 working, 2 unknown')
  expect(teamStatus(nodes, statuses, [], 'g', { a: {} }).summary).toBe('1 working, 1 stopped, 1 unknown')
})
