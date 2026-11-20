import { expect, test } from 'vitest'
import { hookFromAnotherNode, refusalLog } from '../../src/main/control/hookIdentity'
import type { CanvasNode, ClaudeNode } from '../../src/shared/model'

const agent = (id: string, sessionId: string | null): ClaudeNode => ({
  id,
  kind: 'claude',
  agent: 'codex',
  title: id,
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  parentId: null,
  cwd: 'C:\\work',
  sessionId,
  transcriptPath: null,
  after: []
})

const nodes: CanvasNode[] = [agent('a', 'session-a'), agent('b', 'session-b'), agent('fresh', null)]
const allRunning = (): boolean => true

test("a hook sent as one node for a running node's session is from that node", () => {
  // Node b's hook, run by a shared server with node a's environment, arrives as a with a's valid token.
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-b' }, nodes, allRunning)).toBe('b')
})

test('a session whose node has exited passes, as when the person resumes it in another node', () => {
  const running = (id: string): boolean => id !== 'b'
  expect(hookFromAnotherNode('a', { hook_event_name: 'SessionStart', session_id: 'session-b' }, nodes, running)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-b' }, nodes, running)).toBeNull()
})

test("a node's own session passes", () => {
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-a' }, nodes, allRunning)).toBeNull()
})

test('a session no node has yet passes, as a first SessionStart or one after /clear does', () => {
  expect(hookFromAnotherNode('fresh', { hook_event_name: 'SessionStart', session_id: 'session-new' }, nodes, allRunning)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'SessionStart', session_id: 'session-after-clear' }, nodes, allRunning)).toBeNull()
})

test('a hook with no session id, as a signalled one, passes', () => {
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop' }, nodes, allRunning)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 42 }, nodes, allRunning)).toBeNull()
})

test('two nodes holding the same session both pass', () => {
  const shared = [...nodes, agent('a2', 'session-a')]
  expect(hookFromAnotherNode('a2', { hook_event_name: 'Stop', session_id: 'session-a' }, shared, allRunning)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-a' }, shared, allRunning)).toBeNull()
})

test('refusals are logged once per pair of nodes, then every hundredth', () => {
  const lines: string[] = []
  const note = refusalLog((line) => lines.push(line))
  for (let i = 0; i < 250; i++) note('a', 'b', 'PostToolUse')
  note('c', 'b', 'Stop')
  expect(lines).toHaveLength(4)
  expect(lines[0]).toContain('PostToolUse hook sent as a')
  expect(lines[1]).toContain('Refused 100 hooks')
  expect(lines[2]).toContain('Refused 200 hooks')
  expect(lines[3]).toContain('sent as c')
})
