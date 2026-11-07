import { expect, test, vi } from 'vitest'
import { nextStatus, type StatusEvent } from '../../src/core/status/machine'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { AgentStatus } from '../../src/shared/model'

const hook = (name: string, extra: Partial<Extract<StatusEvent, { type: 'hook' }>> = {}): StatusEvent => ({
  type: 'hook',
  name,
  ...extra
})

test.each<[AgentStatus, string, string | undefined, AgentStatus]>([
  ['starting', 'UserPromptSubmit', undefined, 'working'],
  ['working', 'PreToolUse', undefined, 'working'],
  ['working', 'Stop', undefined, 'idle'],
  ['working', 'Notification', 'permission_prompt', 'needs-you'],
  ['working', 'PermissionRequest', undefined, 'needs-you'],
  ['needs-you', 'PostToolUse', undefined, 'working'],
  ['needs-you', 'PostToolUseFailure', undefined, 'working'],
  ['needs-you', 'UserPromptSubmit', undefined, 'working'],
  ['idle', 'Notification', 'idle_prompt', 'idle'],
  ['working', 'SessionEnd', undefined, 'exited'],
  // After an interrupt only a later hook can say what's true.
  ['unknown', 'UserPromptSubmit', undefined, 'working'],
  ['unknown', 'PreToolUse', undefined, 'working'],
  ['unknown', 'Stop', undefined, 'idle'],
  ['working', 'StopFailure', undefined, 'unknown'],
  ['working', 'Notification', 'elicitation_dialog', 'needs-you'],
  ['working', 'Notification', 'elicitation_url_dialog', 'needs-you'],
  ['working', 'Notification', 'agent_needs_input', 'needs-you'],
  ['working', 'Notification', 'auth_success', 'working'],
  ['working', 'Notification', undefined, 'working']
])('hook table %s + %s (%s)', (cur, name, notificationType, expected) => {
  expect(nextStatus(cur, hook(name, { notificationType }))).toBe(expected)
})

test('an interrupt key while working or needs-you gives unknown', () => {
  expect(nextStatus('working', { type: 'interrupt-key' })).toBe('unknown')
  expect(nextStatus('needs-you', { type: 'interrupt-key' })).toBe('unknown')
})

test('an interrupt key while idle stays idle', () => {
  expect(nextStatus('idle', { type: 'interrupt-key' })).toBe('idle')
  expect(nextStatus('starting', { type: 'interrupt-key' })).toBe('starting')
})

test('process-exit always gives exited', () => {
  for (const s of ['queued', 'starting', 'working', 'idle', 'needs-you', 'exited', 'unknown'] as AgentStatus[]) {
    expect(nextStatus(s, { type: 'process-exit' })).toBe('exited')
  }
})

test('an unrecognized hook name leaves status unchanged', () => {
  expect(nextStatus('working', hook('SomeFutureEvent'))).toBe('working')
  expect(nextStatus('idle', hook('SomeFutureEvent'))).toBe('idle')
})

test('launched gives starting', () => {
  expect(nextStatus('exited', { type: 'launched' })).toBe('starting')
  expect(nextStatus('queued', { type: 'launched' })).toBe('starting')
})

test('SessionEnd for /clear or /resume keeps the process alive, so status is unchanged', () => {
  expect(nextStatus('idle', hook('SessionEnd', { reason: 'clear' }))).toBe('idle')
  expect(nextStatus('idle', hook('SessionEnd', { reason: 'resume' }))).toBe('idle')
  expect(nextStatus('idle', hook('SessionEnd', { reason: 'prompt_input_exit' }))).toBe('exited')
  expect(nextStatus('idle', hook('SessionEnd', { reason: 'other' }))).toBe('exited')
})

test('SessionStart means a new launch is ready for input, and changes nothing later on', () => {
  expect(nextStatus('starting', hook('SessionStart'))).toBe('idle')
  expect(nextStatus('working', hook('SessionStart'))).toBe('working') // source: compact
  expect(nextStatus('idle', hook('SessionStart'))).toBe('idle') // source: clear
})

test('a late hook cannot revive an exited node', () => {
  expect(nextStatus('exited', hook('PostToolUse'))).toBe('exited')
  expect(nextStatus('exited', hook('Stop'))).toBe('exited')
})

test('answering an approval moves needs-you to working, and nothing else', () => {
  expect(nextStatus('needs-you', { type: 'approval-answered' })).toBe('working')
  expect(nextStatus('unknown', { type: 'approval-answered' })).toBe('unknown')
  expect(nextStatus('idle', { type: 'approval-answered' })).toBe('idle')
})

test('notify fires on transitions into idle and needs-you, once each', () => {
  const notify = vi.fn()
  const t = createStatusTracker({ notify })
  t.apply('a', { type: 'launched' })
  t.apply('a', hook('UserPromptSubmit'))
  expect(notify).not.toHaveBeenCalled()
  t.apply('a', hook('PermissionRequest'))
  t.apply('a', hook('Notification', { notificationType: 'permission_prompt' }))
  expect(notify.mock.calls).toEqual([['a', 'needs-you']])
  t.apply('a', hook('PostToolUse'))
  t.apply('a', hook('Stop'))
  t.apply('a', hook('Stop'))
  t.apply('a', hook('Notification', { notificationType: 'idle_prompt' }))
  expect(notify.mock.calls).toEqual([
    ['a', 'needs-you'],
    ['a', 'idle']
  ])
})

test('a session becoming ready is not news, so it does not notify', () => {
  const notify = vi.fn()
  const t = createStatusTracker({ notify })
  t.apply('a', { type: 'launched' })
  t.apply('a', hook('SessionStart'))
  expect(t.get('a')).toBe('idle')
  expect(notify).not.toHaveBeenCalled()
})

test('tracker counts only working-to-idle as a completed turn', () => {
  const t = createStatusTracker({ notify: () => {} })
  t.apply('a', { type: 'launched' })
  t.apply('a', hook('SessionStart'))
  expect(t.turnsCompleted('a')).toBe(0)
  t.apply('a', hook('Stop'))
  expect(t.turnsCompleted('a')).toBe(0)
  t.apply('a', hook('UserPromptSubmit'))
  t.apply('a', hook('Stop'))
  expect(t.turnsCompleted('a')).toBe(1)
  t.apply('a', hook('Stop'))
  expect(t.turnsCompleted('a')).toBe(1)
  t.apply('a', hook('UserPromptSubmit'))
  t.apply('a', { type: 'process-exit' })
  expect(t.turnsCompleted('a')).toBe(1)
})

test('a turn ending from needs-you or unknown still counts, or --after would wait forever', () => {
  const t = createStatusTracker({ notify: () => {} })
  t.apply('a', hook('UserPromptSubmit'))
  t.apply('a', hook('PermissionRequest'))
  t.apply('a', hook('Stop')) // denied in the terminal
  expect(t.turnsCompleted('a')).toBe(1)
  t.apply('a', hook('UserPromptSubmit'))
  t.apply('a', { type: 'interrupt-key' })
  t.apply('a', hook('Stop'))
  expect(t.turnsCompleted('a')).toBe(2)
})

test('an unseen node reads as unknown with no turns', () => {
  const t = createStatusTracker({ notify: () => {} })
  expect(t.get('ghost')).toBe('unknown')
  expect(t.turnsCompleted('ghost')).toBe(0)
  expect(t.all()).toEqual({})
})

test('all and onChange report each change, and only real changes', () => {
  const t = createStatusTracker({ notify: () => {} })
  const changes: Array<[string, AgentStatus]> = []
  t.onChange((id, s) => changes.push([id, s]))
  t.apply('a', { type: 'launched' })
  t.apply('a', hook('UserPromptSubmit'))
  t.apply('a', hook('PreToolUse'))
  t.apply('b', { type: 'launched' })
  expect(changes).toEqual([
    ['a', 'starting'],
    ['a', 'working'],
    ['b', 'starting']
  ])
  expect(t.all()).toEqual({ a: 'working', b: 'starting' })
})

test('a node held for --after reads queued until it launches', () => {
  const t = createStatusTracker({ notify: () => {} })
  t.apply('a', { type: 'queued' })
  expect(t.get('a')).toBe('queued')
  t.apply('a', { type: 'launched' })
  expect(t.get('a')).toBe('starting')
})
