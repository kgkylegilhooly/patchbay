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

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`

test("an agent's message goes as one bracketed paste, so a long one isn't cut at ConPTY's 1 KB reads, and Enter follows on its own", () => {
  const { queue, host } = setup()
  const long = 'x'.repeat(3000)
  queue.add('a', { text: long })
  vi.advanceTimersByTime(100)
  expect(host.writes.filter(([id]) => id === 'a').map(([, d]) => d)).toEqual([PASTE(long), '\r'])
})

test("an agent whose screen turned bracketed paste off gets plain text; one that hasn't said gets a paste", () => {
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  for (const id of ['off', 'unknown']) host.running.add(id)
  const pasteOn = (id: string) => (id === 'off' ? false : undefined)
  const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 100, settleMs: 5000 }, pasteOn })
  for (const id of ['off', 'unknown']) {
    tracker.apply(id, { type: 'launched' })
    tracker.apply(id, { type: 'hook', name: 'SessionStart' })
    queue.add(id, { text: 'hi' })
  }
  expect(host.writes).toEqual([['off', 'hi'], ['unknown', PASTE('hi')]])
})

test('a terminal never gets a paste, as text sent to a shell may mean keys', () => {
  const { queue, host } = setup()
  host.running.add('t')
  queue.type('t', 'ls')
  expect(host.writes).toEqual([['t', 'ls']])
})

test('the delivered callback of a waiting message hears when it was typed', () => {
  const { queue, tracker, host } = setup()
  tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
  let typedAt = -1
  expect(queue.add('a', { text: 'later', onDelivered: () => (typedAt = host.writes.length) })).toBe('queued')
  tracker.apply('a', { type: 'hook', name: 'Stop' })
  expect(typedAt).toBe(1)
})

test('onTyped hears each message typed, before its Enter, and not one handed over by take', () => {
  const { queue, tracker, host } = setup()
  const typed: string[] = []
  queue.add('a', { text: 'now', onTyped: () => typed.push(`now@${host.writes.length}`) })
  expect(typed).toEqual(['now@1'])
  vi.advanceTimersByTime(10_000)
  tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
  queue.add('a', { text: 'taken', onTyped: () => typed.push('taken') })
  expect(queue.take('a', () => true)).toHaveLength(1)
  tracker.apply('a', { type: 'hook', name: 'Stop' })
  expect(typed).toEqual(['now@1'])
})

test('a message waits while the person has half-typed something at the prompt, then goes once they stop', () => {
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('a')
  let drafting = true
  const settled: Array<(id: string) => void> = []
  const queue = createSendQueue({
    host,
    tracker,
    exists: () => true,
    timing: { enterDelayMs: 100, settleMs: 5000 },
    draft: { drafting: () => drafting, onDraftSettled: (cb) => void settled.push(cb) }
  })
  tracker.apply('a', { type: 'launched' })
  tracker.apply('a', { type: 'hook', name: 'SessionStart' })
  expect(queue.add('a', { text: 'from the lead' })).toBe('queued')
  expect(queue.busy('a')).toBe(true)
  expect(host.writes).toEqual([])
  drafting = false
  for (const cb of settled) cb('a')
  expect(host.writes).toHaveLength(1)
})
