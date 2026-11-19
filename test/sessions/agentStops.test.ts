import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { continueAtReset, createAgentStops } from '../../src/main/sessions/agentStops'
import { foldMissedHooks, takeMissedHooks } from '../../src/main/sessions/missedHooks'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { RELEASE_MARGIN_MS } from '../../src/shared/agentStop'
import { fakeHost } from '../control/fakes'

const START = new Date(2026, 10, 19, 21, 40).getTime()
const RESET = new Date(2026, 10, 20, 0, 30).getTime()
const LIMIT = { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => vi.useRealTimers())

function setup({ continueOn = false } = {}) {
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('a')
  const stops = createAgentStops({ tracker, continueEnabled: () => continueOn })
  const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 10, settleMs: 100 }, hold: stops })
  continueAtReset(stops, queue)
  const hook = (payload: Record<string, unknown>): void => {
    tracker.apply('a', { type: 'hook', name: String(payload.hook_event_name) })
    stops.noteHook('a', payload)
  }
  tracker.apply('a', { type: 'launched' })
  hook({ hook_event_name: 'SessionStart' })
  hook({ hook_event_name: 'UserPromptSubmit' })
  const typed = () => host.writes.filter(([id, d]) => id === 'a' && d !== '\r').map(([, d]) => d.replace(/\x1b\[20[01]~/g, ''))
  return { tracker, host, stops, queue, hook, typed }
}

test('a usage limit keeps the status unknown, records why, and holds messages until the reset', () => {
  const { tracker, stops, queue, hook, typed } = setup()
  hook(LIMIT)
  expect(tracker.get('a')).toBe('unknown')
  expect(stops.get('a')).toMatchObject({ kind: 'usage-limit', until: RESET, holds: 'reset', willContinue: false })
  expect(queue.add('a', { text: 'carry on with step 2' })).toBe('queued')
  vi.advanceTimersByTime(RESET - START)
  expect(typed()).toEqual([])
  vi.advanceTimersByTime(RELEASE_MARGIN_MS)
  expect(typed()).toEqual(['carry on with step 2'])
  // It takes the message: the stop is over and the queue is back to normal.
  hook({ hook_event_name: 'UserPromptSubmit' })
  expect(stops.get('a')).toBeUndefined()
  expect(queue.busy('a')).toBe(false)
})

test('the person can still type: their prompt clears the stop, and queued messages follow the turn as usual', () => {
  const { stops, queue, hook, typed } = setup()
  hook(LIMIT)
  queue.add('a', { text: 'later' })
  hook({ hook_event_name: 'UserPromptSubmit' })
  expect(stops.get('a')).toBeUndefined()
  expect(typed()).toEqual([])
  hook({ hook_event_name: 'Stop' })
  expect(typed()).toEqual(['later'])
})

test('a login failure holds messages until the node moves, however long that takes', () => {
  const { queue, hook, typed } = setup()
  hook({ hook_event_name: 'StopFailure', error: 'authentication_failed' })
  queue.add('a', { text: 'hello' })
  vi.advanceTimersByTime(7 * 86400_000)
  expect(typed()).toEqual([])
})

test('a server error holds nothing: the agent is at its prompt, so what was waiting goes now', () => {
  const { queue, hook, typed } = setup()
  queue.add('a', { text: 'waiting' })
  hook({ hook_event_name: 'StopFailure', error: 'server_error' })
  expect(typed()).toEqual(['waiting'])
})

test('continue at reset, when on, goes once to a node still stopped with nothing waiting', () => {
  const { stops, hook, typed } = setup({ continueOn: true })
  hook(LIMIT)
  expect(stops.get('a')?.willContinue).toBe(true)
  vi.advanceTimersByTime(RESET - START + RELEASE_MARGIN_MS)
  expect(typed()).toEqual(['continue'])
  // It hits the limit again at once: not continued a second time.
  hook({ hook_event_name: 'UserPromptSubmit' })
  hook({ ...LIMIT, last_assistant_message: "You've hit your 5-hour limit · resets 5:30am" })
  expect(stops.get('a')?.willContinue).toBe(false)
  vi.advanceTimersByTime(6 * 3600_000)
  expect(typed()).toEqual(['continue'])
})

test('continue at reset sends nothing of its own when a message is waiting, and nothing when off', () => {
  const on = setup({ continueOn: true })
  on.hook(LIMIT)
  on.queue.add('a', { text: 'your next step' })
  vi.advanceTimersByTime(RESET - START + RELEASE_MARGIN_MS)
  expect(on.typed()).toEqual(['your next step'])

  vi.setSystemTime(START)
  const off = setup()
  off.hook(LIMIT)
  vi.advanceTimersByTime(RESET - START + RELEASE_MARGIN_MS)
  expect(off.typed()).toEqual([])
})

test('an idle node is never continued: a turn that ended normally clears its stop', () => {
  const { hook, typed, stops } = setup({ continueOn: true })
  hook(LIMIT)
  hook({ hook_event_name: 'UserPromptSubmit' })
  hook({ hook_event_name: 'Stop' })
  expect(stops.get('a')).toBeUndefined()
  vi.advanceTimersByTime(RESET - START + RELEASE_MARGIN_MS)
  expect(typed()).toEqual([])
})

test('a StopFailure for a node that is not unknown afterwards, such as one exited, records nothing', () => {
  const { tracker, stops } = setup()
  tracker.apply('a', { type: 'process-exit' })
  stops.noteHook('a', LIMIT)
  expect(stops.get('a')).toBeUndefined()
})

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

test('the hook forwards why a turn failed, capped, and only for StopFailure; the journal keeps it for catching up', () => {
  dir = mkdtempSync(join(tmpdir(), 'pb-stop-'))
  const run = (event: Record<string, unknown>): void => {
    spawnSync(process.execPath, [resolve('resources/hook.cjs'), String(event.hook_event_name)], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATCHBAY_ENDPOINT_FILE: join(dir, 'endpoint.json'), PATCHBAY_NODE_ID: 'n', PATCHBAY_TOKEN: 't' }
    })
  }
  run({ hook_event_name: 'UserPromptSubmit' })
  run({ ...LIMIT, error_details: 'x'.repeat(5000) })
  run({ hook_event_name: 'Stop', last_assistant_message: 'a long answer' })
  const events = takeMissedHooks(join(dir, 'missed'), 'n')
  expect(events[1]).toMatchObject({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: LIMIT.last_assistant_message })
  expect((events[1] as { error_details: string }).error_details).toHaveLength(1000)
  expect(events[2]).not.toHaveProperty('last_assistant_message')
  // Ending on Stop, the failure before it no longer explains anything.
  expect(foldMissedHooks(events).stopFailure).toBeUndefined()
  expect(foldMissedHooks(events.slice(0, 2)).stopFailure).toMatchObject({ error: 'rate_limit' })
})
