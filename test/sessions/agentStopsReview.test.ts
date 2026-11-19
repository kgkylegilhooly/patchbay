import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { continueAtReset, createAgentStops, stopFile, type SavedStops, type StopStore } from '../../src/main/sessions/agentStops'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { parseResetTime, RELEASE_MARGIN_MS, stopLabel } from '../../src/shared/agentStop'
import { needsYouQueue } from '../../src/renderer/needsYou'
import { claudeNode } from '../control/fakes'
import { fakeHost } from '../control/fakes'

const START = new Date(2026, 10, 19, 22, 0).getTime()
const RESET = new Date(2026, 10, 20, 0, 30).getTime()
const LIMIT = { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" }
const BURST = { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: 429 Too many requests' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => vi.useRealTimers())

function memory(): StopStore & { saved: SavedStops | null } {
  const box = {
    saved: null as SavedStops | null,
    load: () => (box.saved ? JSON.parse(JSON.stringify(box.saved)) : null),
    save: (s: SavedStops) => void (box.saved = s)
  }
  return box
}

/** One launch of the app: a tracker, the stops, and a queue into node `a`, whose session is running. */
function launch(store: StopStore, { continueOn = false } = {}) {
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('a')
  const stops = createAgentStops({ tracker, store, continueEnabled: () => continueOn })
  const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 10, settleMs: 100 }, hold: stops })
  continueAtReset(stops, queue)
  const hook = (payload: Record<string, unknown>): void => {
    tracker.apply('a', { type: 'hook', name: String(payload.hook_event_name) })
    stops.noteHook('a', payload)
  }
  const typed = () => host.writes.filter(([id, d]) => id === 'a' && d !== '\r').map(([, d]) => d.replace(/\x1b\[20[01]~/g, ''))
  return { tracker, stops, queue, hook, typed }
}

test('H1: a stop recorded live survives the app restarting, still holds, and releases at the reset', () => {
  const store = memory()
  const first = launch(store)
  first.tracker.apply('a', { type: 'launched' })
  first.hook({ hook_event_name: 'UserPromptSubmit' })
  first.hook(LIMIT)
  first.stops.dispose()

  vi.advanceTimersByTime(3600_000)
  const second = launch(store, { continueOn: true })
  // Reconnected to the running session, which knows nothing new: seeded unknown, as adoptNode does.
  second.tracker.seed('a', 'unknown')
  second.stops.retain(['a'])
  expect(second.stops.get('a')).toMatchObject({ kind: 'usage-limit', until: RESET, holds: 'reset', willContinue: true })
  expect(second.queue.add('a', { text: 'next step' })).toBe('queued')
  vi.advanceTimersByTime(RESET - START - 3600_000 + RELEASE_MARGIN_MS)
  expect(second.typed()).toEqual(['next step'])
})

test('H1: after a restart, saved stops of sessions that did not come back, or moved on, are dropped and saved so', () => {
  const store = memory()
  const first = launch(store)
  first.hook(LIMIT)
  first.stops.dispose()
  const second = launch(store)
  second.tracker.seed('a', 'unknown')
  second.stops.retain([])
  expect(second.stops.get('a')).toBeUndefined()
  expect(store.saved?.stops).toEqual({})
})

test('H1: the stop file round-trips through disk and ignores damage', async () => {
  vi.useRealTimers()
  const dir = mkdtempSync(join(tmpdir(), 'pb-stops-'))
  try {
    const path = join(dir, 'agent-stops.json')
    const file = stopFile(path)
    const saved: SavedStops = { stops: { a: { kind: 'usage-limit', at: START, until: RESET, message: 'm', holds: 'reset' } }, continued: ['b'] }
    file.save(saved)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(saved))
    expect(file.load()).toEqual(saved)
    writeFileSync(path, JSON.stringify({ stops: { a: { kind: 'nonsense' }, b: saved.stops.a }, continued: [1, 'c'] }))
    expect(file.load()).toEqual({ stops: { b: saved.stops.a }, continued: ['c'] })
    writeFileSync(path, '{not json')
    expect(file.load()).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M1: the release looks at the clock at least once a minute, so a jump in wall time (as after sleep) is caught', () => {
  const { hook, queue, typed } = launch(memory())
  hook({ hook_event_name: 'UserPromptSubmit' })
  hook(LIMIT)
  queue.add('a', { text: 'after sleep' })
  // The wall clock passes the reset while the timers barely move, as when the PC sleeps.
  vi.setSystemTime(RESET + RELEASE_MARGIN_MS + 1000)
  vi.advanceTimersByTime(60_000)
  expect(typed()).toEqual(['after sleep'])
})

test('M2: a rate limit with no reset time is retried after a minute, then after longer if it hits again', () => {
  const { hook, queue, typed, stops } = launch(memory())
  hook({ hook_event_name: 'UserPromptSubmit' })
  hook(BURST)
  expect(stops.get('a')).toMatchObject({ kind: 'rate-limit', holds: 'reset', retry: true, until: START + 60_000, willContinue: false })
  expect(stopLabel(stops.get('a')!, START)).toBe('Rate limited, retrying at 22:01')
  queue.add('a', { text: 'one' })
  queue.add('a', { text: 'two' })
  vi.advanceTimersByTime(60_000)
  expect(typed()).toEqual(['one'])
  hook({ hook_event_name: 'UserPromptSubmit' })
  hook(BURST)
  expect(stops.get('a')?.until).toBe(Date.now() + 120_000)
  vi.advanceTimersByTime(119_000)
  expect(typed()).toEqual(['one'])
  vi.advanceTimersByTime(1000)
  expect(typed()).toEqual(['one', 'two'])
})

test('L1: Next needing you includes an agent stopped at its limit, as the Status tab does', () => {
  const doc = { version: 3, projects: [], activeProjectId: '', nodes: [claudeNode('a'), claudeNode('b')], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
  const statuses = { a: 'unknown', b: 'unknown' } as const
  expect(needsYouQueue(doc as never, statuses, [], {}, false).map((e) => e.id)).toEqual([])
  expect(needsYouQueue(doc as never, statuses, [], {}, false, { a: {} }).map((e) => e.id)).toEqual(['a'])
})

test('L2: a reset time naming another zone is read in that zone', () => {
  const after = Date.UTC(2026, 10, 19, 22, 0)
  // 12:30am in New York (UTC-5 in November) is 05:30 UTC.
  expect(parseResetTime('resets 12:30am (America/New_York)', after, 'Europe/London')).toBe(Date.UTC(2026, 10, 20, 5, 30))
  expect(parseResetTime('resets Nov 21, 9am (Asia/Tokyo)', after, 'Europe/London')).toBe(Date.UTC(2026, 10, 21, 0, 0))
  expect(parseResetTime('resets 12:30am (Not/AZone)', after, 'Europe/London')).toBeNull()
  // Its own zone is read as local time, as before.
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  expect(parseResetTime(`resets 12:30am (${local})`, after)).toBe(parseResetTime('resets 12:30am', after))
})
