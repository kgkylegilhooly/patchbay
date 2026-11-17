import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { fakeHost } from './fakes'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('a')
  const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 100, settleMs: 5000, retryEnterMs: 1000 } })
  tracker.apply('a', { type: 'launched' })
  tracker.apply('a', { type: 'hook', name: 'SessionStart' })
  const enters = () => host.writes.filter(([id, d]) => id === 'a' && d === '\r').length
  return { tracker, host, queue, enters }
}

test('an agent left idle after Enter, its message typed but not sent, gets Enter once more', () => {
  const { queue, enters } = setup()
  expect(queue.add('a', { text: 'hello' })).toBe('delivered')
  vi.advanceTimersByTime(100)
  expect(enters()).toBe(1)
  vi.advanceTimersByTime(1000)
  expect(enters()).toBe(2)
  vi.advanceTimersByTime(10_000)
  expect(enters()).toBe(2)
})

test('an agent that took the message gets no second Enter, even once it is idle again', () => {
  const { queue, tracker, enters } = setup()
  queue.add('a', { text: 'hello' })
  vi.advanceTimersByTime(100)
  tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
  tracker.apply('a', { type: 'hook', name: 'Stop' })
  vi.advanceTimersByTime(1000)
  expect(enters()).toBe(1)
})

test('a terminal, which has no status, gets Enter once', () => {
  const { queue, host } = setup()
  host.running.add('t')
  queue.type('t', 'ls')
  vi.advanceTimersByTime(5000)
  expect(host.writes.filter(([id, d]) => id === 't' && d === '\r')).toHaveLength(1)
})

test('no second Enter for a session that has ended', () => {
  const { queue, host, enters } = setup()
  queue.add('a', { text: 'hello' })
  vi.advanceTimersByTime(100)
  host.running.delete('a')
  vi.advanceTimersByTime(1000)
  expect(enters()).toBe(1)
})

test('text typed into a terminal goes after whatever the guard puts ahead of it, and Enter follows on its own', () => {
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('t')
  const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 100, settleMs: 5000 }, prefix: (id) => (id === 't' ? '\x00' : '') })
  queue.type('t', 'npm test')
  vi.advanceTimersByTime(100)
  expect(host.writes.filter(([id]) => id === 't').map(([, d]) => d)).toEqual(['\x00npm test', '\r'])
})
