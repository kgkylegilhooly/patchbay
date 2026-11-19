import { expect, test } from 'vitest'
import { hookFromAnotherNode } from '../../src/main/control/hookIdentity'
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

test("a hook sent as one node for another node's session is from the other node", () => {
  // Node b's hook, run by a shared server with node a's environment, arrives as a with a's valid token.
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-b' }, nodes)).toBe('b')
})

test("a node's own session passes", () => {
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-a' }, nodes)).toBeNull()
})

test('a session no node has yet passes, as a first SessionStart or one after /clear does', () => {
  expect(hookFromAnotherNode('fresh', { hook_event_name: 'SessionStart', session_id: 'session-new' }, nodes)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'SessionStart', session_id: 'session-after-clear' }, nodes)).toBeNull()
})

test('a hook with no session id, as a signalled one, passes', () => {
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop' }, nodes)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 42 }, nodes)).toBeNull()
})

test('two nodes holding the same session both pass', () => {
  const shared = [...nodes, agent('a2', 'session-a')]
  expect(hookFromAnotherNode('a2', { hook_event_name: 'Stop', session_id: 'session-a' }, shared)).toBeNull()
  expect(hookFromAnotherNode('a', { hook_event_name: 'Stop', session_id: 'session-a' }, shared)).toBeNull()
})
