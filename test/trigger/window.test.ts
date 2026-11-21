import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { armRefusal, canonicalSpec, isArmed } from '../../src/core/trigger/arming'
import { reduce } from '../../src/core/canvas/reduce'
import { migrate } from '../../src/core/persist/docStore'
import { describeSchedule, nextRun, nextRuns, slotsUpTo, windowEnded } from '../../src/core/trigger/schedule'
import { describeWhen, inWindow, windowError, windowOf } from '../../src/core/trigger/window'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTriggerService } from '../../src/main/triggers/service'
import type { CanvasDoc, TriggerNode, TriggerSchedule } from '../../src/shared/model'
import { claudeNode, fakeHost, memoryStore, terminalNode } from '../control/fakes'
import { nextLabel, triggerState, windowDraftOf, windowFieldsOf } from '../../src/renderer/triggerView'
import { triggerNode } from './fixtures'

const MIN = 60_000
const HOUR = 60 * MIN
const EVERY_5: TriggerSchedule = { type: 'interval', everyMs: 5 * MIN }
/** 21 Nov 2026 14:00 and 22 Nov 09:00, local time. */
const START = new Date(2026, 10, 21, 14, 0).getTime()
const END = new Date(2026, 10, 22, 9, 0).getTime()

describe('nextRun with a window', () => {
  test('an interval with a start counts from the start, and the start itself is a slot', () => {
    const w = { startsAt: START }
    expect(nextRun(EVERY_5, START - HOUR, START - HOUR, w)).toBe(START)
    expect(nextRun(EVERY_5, START - 1, 0, w)).toBe(START)
    expect(nextRun(EVERY_5, START, 0, w)).toBe(START + 5 * MIN)
    expect(nextRun(EVERY_5, START + 7 * MIN, 0, w)).toBe(START + 10 * MIN)
  })

  test('a start that has passed keeps the slots on its grid, rather than counting from when it was armed', () => {
    const armedAt = START + 7 * MIN
    expect(nextRun(EVERY_5, armedAt, armedAt, { startsAt: START })).toBe(START + 10 * MIN)
    // Without a start, it counts from when it was armed, as it always did.
    expect(nextRun(EVERY_5, armedAt, armedAt, {})).toBe(armedAt + 5 * MIN)
    expect(nextRun(EVERY_5, armedAt, armedAt, { startsAt: null, endsAt: null })).toBe(armedAt + 5 * MIN)
    expect(nextRun(EVERY_5, armedAt, armedAt)).toBe(armedAt + 5 * MIN)
  })

  test('nothing after the end, which can itself be a slot', () => {
    const w = { startsAt: START, endsAt: START + 10 * MIN }
    expect(nextRun(EVERY_5, START + 5 * MIN, 0, w)).toBe(START + 10 * MIN)
    expect(nextRun(EVERY_5, START + 10 * MIN, 0, w)).toBeNull()
    expect(nextRun(EVERY_5, START + 7 * MIN, 0, { endsAt: START + 9 * MIN, startsAt: START })).toBeNull()
    // An end alone: slots still count from when it was armed.
    expect(nextRun(EVERY_5, 0, 0, { endsAt: 7 * MIN })).toBe(5 * MIN)
    expect(nextRun(EVERY_5, 5 * MIN, 0, { endsAt: 7 * MIN })).toBeNull()
  })

  test('cron: only times at or after the start, and up to the end', () => {
    const hourly: TriggerSchedule = { type: 'cron', expr: '0 * * * *' }
    expect(nextRun(hourly, START - 3 * HOUR, 0, { startsAt: START })).toBe(START)
    expect(nextRun(hourly, START - 3 * HOUR, 0, { startsAt: START + 1 })).toBe(START + HOUR)
    expect(nextRun(hourly, START, 0, { startsAt: START })).toBe(START + HOUR)
    expect(nextRun(hourly, START + HOUR, 0, { endsAt: START + 2 * HOUR })).toBe(START + 2 * HOUR)
    expect(nextRun(hourly, START + 2 * HOUR, 0, { endsAt: START + 2 * HOUR })).toBeNull()
    expect(nextRun(hourly, START - 3 * HOUR, 0, {})).toBe(START - 2 * HOUR)
  })

  test('a one-off keeps its own time: no window applies to it', () => {
    const once: TriggerSchedule = { type: 'once', at: START }
    expect(nextRun(once, 0, 0, { startsAt: START + HOUR, endsAt: START + 2 * HOUR })).toBe(START)
    expect(windowOf({ schedule: once, startsAt: START + HOUR })).toBeNull()
  })

  test('an event has no slots, window or not', () => {
    expect(nextRun({ type: 'agent', nodeId: 'a', on: 'turn' }, 0, 0, { startsAt: START })).toBeNull()
  })

  test('nextRuns starts at the start and stops at the end', () => {
    expect(nextRuns(EVERY_5, START - HOUR, START - HOUR, 5, { startsAt: START, endsAt: START + 10 * MIN })).toEqual([START, START + 5 * MIN, START + 10 * MIN])
  })

  test('interval slots are exact milliseconds from the start, so a clock change does not move them', () => {
    // Across the last Sunday in March and October, when many zones change their clocks.
    for (const start of [new Date(2026, 2, 28, 22, 0).getTime(), new Date(2026, 9, 24, 22, 0).getTime()]) {
      const runs = nextRuns({ type: 'interval', everyMs: HOUR }, start - 1, 0, 30, { startsAt: start })
      expect(runs[0]).toBe(start)
      expect(runs.every((t, i) => t === start + i * HOUR)).toBe(true)
    }
  })

  test('cron with a start counts in local time, whatever the clock does', () => {
    const start = new Date(2026, 2, 29, 0, 0).getTime()
    const runs = nextRuns({ type: 'cron', expr: '0 9 * * *' }, start - 1, 0, 3, { startsAt: start })
    expect(runs.map((t) => new Date(t).getHours())).toEqual([9, 9, 9])
    expect(runs.map((t) => new Date(t).getDate())).toEqual([29, 30, 31])
  })
})

describe('missed slots across the window edges', () => {
  test('counted from the first slot due, never past the end', () => {
    const w = { startsAt: START, endsAt: START + 20 * MIN }
    // Closed from before the start until long after the end: the slots are 14:00 to 14:20, five of them.
    expect(slotsUpTo(EVERY_5, START, START + 5 * HOUR, 0, w)).toEqual({ count: 5, last: START + 20 * MIN, capped: false })
    // Closed partway in.
    expect(slotsUpTo(EVERY_5, START + 10 * MIN, START + 12 * MIN, 0, w)).toEqual({ count: 1, last: START + 10 * MIN, capped: false })
  })
})

describe('window rules', () => {
  test('inWindow is inclusive at both ends', () => {
    const w = { start: START, end: END }
    expect(inWindow(w, START - 1)).toBe(false)
    expect(inWindow(w, START)).toBe(true)
    expect(inWindow(w, END)).toBe(true)
    expect(inWindow(w, END + 1)).toBe(false)
    expect(inWindow(null, 0)).toBe(true)
    expect(inWindow({ start: null, end: END }, 0)).toBe(true)
  })

  test('the end must be after the start, and each must be a time', () => {
    expect(windowError({ schedule: EVERY_5, startsAt: START, endsAt: START })).toMatch(/end must be after the start/)
    expect(windowError({ schedule: EVERY_5, startsAt: END, endsAt: START })).toMatch(/end must be after the start/)
    expect(windowError({ schedule: EVERY_5, startsAt: NaN })).toMatch(/start/)
    expect(windowError({ schedule: EVERY_5, endsAt: NaN })).toMatch(/end/)
    expect(windowError({ schedule: EVERY_5, startsAt: START, endsAt: END })).toBeNull()
    expect(windowError({ schedule: EVERY_5 })).toBeNull()
  })

  test('ended: the end has passed, or no slot is left before it', () => {
    expect(windowEnded({ schedule: EVERY_5, endsAt: END }, END + 1)).toBe(true)
    expect(windowEnded({ schedule: EVERY_5, endsAt: END }, END - HOUR)).toBe(false)
    expect(windowEnded({ schedule: EVERY_5, endsAt: END }, END - MIN)).toBe(true)
    expect(windowEnded({ schedule: { type: 'agent', nodeId: 'a', on: 'turn' }, endsAt: END }, END - MIN)).toBe(false)
    expect(windowEnded({ schedule: EVERY_5 }, END + 1)).toBe(false)
  })

  test('described after the schedule', () => {
    const now = START - HOUR
    expect(describeWhen(START, now)).toBe('21 Nov 14:00')
    expect(describeWhen(new Date(2027, 0, 2, 9, 5).getTime(), now)).toBe('2 Jan 2027 09:05')
    vi.useFakeTimers({ now })
    try {
      expect(describeSchedule(EVERY_5, undefined, { startsAt: START, endsAt: END })).toBe('Every 5 minutes, from 21 Nov 14:00 until 22 Nov 09:00')
      expect(describeSchedule(EVERY_5, undefined, { startsAt: START })).toBe('Every 5 minutes, from 21 Nov 14:00')
      expect(describeSchedule({ type: 'cron', expr: '0 9 * * *' }, undefined, { endsAt: END })).toBe('Cron: 0 9 * * * (local time), until 22 Nov 09:00')
      expect(describeSchedule(EVERY_5, undefined, {})).toBe('Every 5 minutes')
      expect(describeSchedule(EVERY_5)).toBe('Every 5 minutes')
      expect(describeSchedule({ type: 'once', at: START }, undefined, { endsAt: END })).not.toMatch(/until/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('arming agrees to the window', () => {
  const doc = (t: TriggerNode) => ({ nodes: [terminalNode('t', { projectId: 'p' }), t] })

  test('a trigger with no window keeps exactly the spec it had, so old saves stay armed', () => {
    const t = triggerNode('tr', { projectId: 'p' })
    expect(canonicalSpec(t)).toBe(JSON.stringify([['interval', 60_000], 'check the build', 't']))
    expect(canonicalSpec({ ...t, startsAt: null, endsAt: null })).toBe(canonicalSpec(t))
    expect(isArmed({ ...t, armedSpec: canonicalSpec(t), startsAt: null })).toBe(true)
  })

  test('the window is part of the spec, so changing it disarms', () => {
    const t = triggerNode('tr', { projectId: 'p', startsAt: START })
    expect(canonicalSpec(t)).toBe(JSON.stringify([['interval', 60_000], 'check the build', 't', { window: [START, null] }]))
    const armed = { ...t, armedSpec: canonicalSpec(t), armedAt: 1, nextAt: START }
    const before: CanvasDoc = { version: 3, projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p', nodes: [armed], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
    const moved = reduce(before, { op: 'patchNode', id: 'tr', patch: { endsAt: END } }).nodes[0] as TriggerNode
    expect(moved.armedSpec).toBeNull()
    const same = reduce(before, { op: 'patchNode', id: 'tr', patch: { startsAt: START } }).nodes[0] as TriggerNode
    expect(same.armedSpec).toBe(armed.armedSpec)
  })

  test('a start in the past is fine; an end in the past, or one no slot reaches, is refused', () => {
    const now = START + HOUR
    const ok = triggerNode('tr', { projectId: 'p', startsAt: START, endsAt: END })
    expect(armRefusal(ok, doc(ok), now)).toBeNull()
    const past = triggerNode('tr', { projectId: 'p', endsAt: now - MIN })
    expect(armRefusal(past, doc(past), now)).toMatch(/Its end, 21 Nov 14:59, has passed/)
    const tooSoon = triggerNode('tr', { projectId: 'p', schedule: { type: 'interval', everyMs: HOUR }, endsAt: now + MIN })
    expect(armRefusal(tooSoon, doc(tooSoon), now)).toMatch(/No run falls before its end/)
    const backwards = triggerNode('tr', { projectId: 'p', startsAt: END, endsAt: START })
    expect(armRefusal(backwards, doc(backwards), now)).toMatch(/end must be after the start/)
  })
})

describe('saved triggers', () => {
  const docWith = (trigger: Record<string, unknown>) => ({
    version: 3,
    projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: [trigger],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })

  test('one saved before the window existed loads unchanged', () => {
    const old = { ...triggerNode('tr', { projectId: 'p' }) }
    expect('startsAt' in old).toBe(false)
    expect(migrate(docWith(old)).nodes[0]).toEqual(old)
  })

  test('a window loads, and a broken one is refused', () => {
    const t = triggerNode('tr', { projectId: 'p', startsAt: START, endsAt: null })
    expect(migrate(docWith({ ...t })).nodes[0]).toEqual(t)
    expect(() => migrate(docWith({ ...t, startsAt: 'tomorrow' }))).toThrow()
  })
})

describe('the form and the card', () => {
  test('the form keeps no window for a one-off, and empty means none', () => {
    const d = windowDraftOf({ startsAt: START, endsAt: END })
    expect(windowFieldsOf(d, EVERY_5)).toEqual({ startsAt: START, endsAt: END })
    expect(windowFieldsOf(d, { type: 'once', at: START })).toEqual({ startsAt: null, endsAt: null })
    expect(windowFieldsOf({ starts: '', ends: '' }, EVERY_5)).toEqual({ startsAt: null, endsAt: null })
    expect(windowDraftOf(undefined)).toEqual({ starts: '', ends: '' })
  })

  test('a trigger whose end has passed shows as done, not as an error', () => {
    const t = triggerNode('tr', { endsAt: END, runs: [] })
    expect(triggerState(t, END - HOUR)).toBe('disarmed')
    expect(triggerState(t, END + 1)).toBe('done')
    expect(nextLabel(t, END + 1)).toBe('Finished. It ended 22 Nov 09:00.')
  })
})

describe('the service keeps to the window', () => {
  let clock = 0
  beforeEach(() => {
    vi.useFakeTimers()
    clock = START - HOUR
  })
  afterEach(() => vi.useRealTimers())

  function setup(over: Partial<TriggerNode>) {
    const store = memoryStore([terminalNode('t'), claudeNode('a', { title: 'Builder' }), triggerNode('tr', over)])
    const tracker = createStatusTracker({ notify: () => {} })
    const host = fakeHost()
    host.running.add('t')
    host.running.add('a')
    const queue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), timing: { enterDelayMs: 0, settleMs: 10 } })
    const service = createTriggerService({ store, tracker, host, queue, now: () => clock })
    const trig = () => store.get().nodes.find((n) => n.id === 'tr') as TriggerNode
    const typed = () => host.writes.filter(([, d]) => d !== '\r').length
    const advance = (ms: number) => {
      clock += ms
      service.tick()
    }
    return { store, tracker, service, trig, typed, advance, arm: () => service.arm('tr', canonicalSpec(trig())) }
  }

  test('armed before the start, it fires first at the start, then every interval, and finishes at the end', () => {
    const s = setup({ schedule: EVERY_5, startsAt: START, endsAt: START + 10 * MIN })
    s.service.start()
    expect(s.arm()).toEqual({ ok: true })
    expect(s.trig().nextAt).toBe(START)
    s.advance(HOUR - MIN)
    expect(s.typed()).toBe(0)
    s.advance(MIN)
    s.advance(5 * MIN)
    s.advance(5 * MIN)
    expect(s.typed()).toBe(3)
    expect(s.trig().armedSpec).toBeNull()
    expect(triggerState(s.trig(), clock)).toBe('done')
  })

  test('slots missed while closed are counted only up to the end', () => {
    const s = setup({ schedule: EVERY_5, startsAt: START, endsAt: START + 20 * MIN })
    s.service.start()
    s.arm()
    s.service.stop()
    clock = START + 5 * HOUR
    s.service.start()
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', at: START + 20 * MIN, detail: expect.stringMatching(/^Skipped 5 runs/) })
    expect(s.trig().armedSpec).toBeNull()
  })

  test('an event before the start or after the end is ignored, and it finishes at the end', () => {
    const s = setup({ schedule: { type: 'agent', nodeId: 'a', on: 'turn' }, targetId: 't', startsAt: START, endsAt: START + HOUR })
    s.tracker.apply('a', { type: 'launched' })
    s.tracker.apply('a', { type: 'hook', name: 'SessionStart' })
    s.service.start()
    expect(s.arm()).toEqual({ ok: true })
    const turn = () => {
      s.tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
      s.tracker.apply('a', { type: 'hook', name: 'Stop' })
    }
    turn()
    expect(s.typed()).toBe(0)
    expect(s.trig().runs).toEqual([])
    clock = START + MIN
    turn()
    expect(s.typed()).toBe(1)
    s.advance(HOUR)
    expect(s.trig().armedSpec).toBeNull()
    expect(triggerState(s.trig(), clock)).toBe('done')
  })
})
