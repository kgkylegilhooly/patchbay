import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createVerbs } from '../../src/main/control/verbs'
import { createAfterGate } from '../../src/main/control/after'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTriggerService, LATE_LIMIT_MS } from '../../src/main/triggers/service'
import type { CanvasNode, TriggerNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, memoryStore, terminalNode } from '../control/fakes'
import { triggerNode } from './fixtures'

const MIN = 60_000
let clock = 0

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000_000
})
afterEach(() => vi.useRealTimers())

function setup(nodes: CanvasNode[], target: 'terminal' | 'claude' = 'terminal') {
  const store = memoryStore([target === 'terminal' ? terminalNode('t') : claudeNode('t'), ...nodes])
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('t')
  const queue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), timing: { enterDelayMs: 0, settleMs: 10 } })
  const service = createTriggerService({ store, tracker, host, queue, now: () => clock })
  const trig = (id = 'tr') => store.get().nodes.find((n) => n.id === id) as TriggerNode
  const typed = () => host.writes.filter(([, d]) => d !== '\r').map(([id, d]) => `${id}:${d}`)
  const arm = (id = 'tr') => service.arm(id, canonicalSpec(trig(id)))
  const advance = (ms: number) => {
    clock += ms
    service.tick()
  }
  const idle = (id = 't') => {
    tracker.apply(id, { type: 'launched' })
    tracker.apply(id, { type: 'hook', name: 'SessionStart' })
  }
  const working = (id = 't') => tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
  return { store, tracker, host, service, trig, typed, arm, advance, idle, working }
}

describe('arming', () => {
  test('a disarmed trigger never fires, by schedule or by hand', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    s.advance(10 * MIN)
    expect(s.service.runNow('tr')).toMatchObject({ ok: false, reason: /Arm it first/ })
    expect(s.typed()).toEqual([])
    expect(s.trig().runs).toEqual([])
  })

  test('arming needs the spec that was shown, and sets the next run', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    expect(s.service.arm('tr', 'something else')).toMatchObject({ ok: false, reason: /changed after it was shown/ })
    expect(s.arm()).toEqual({ ok: true })
    expect(s.trig().nextAt).toBe(clock + MIN)
  })

  test('arming refuses what armRefusal refuses', () => {
    const s = setup([triggerNode('tr', { targetId: null })])
    expect(s.arm()).toMatchObject({ ok: false, reason: /Choose what it sends to/ })
  })
})

describe('a terminal target', () => {
  test('an armed interval trigger types into it at each slot', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    s.arm()
    s.advance(MIN)
    s.advance(MIN)
    expect(s.typed()).toEqual(['t:check the build', 't:check the build'])
    expect(s.trig().runs.map((r) => r.outcome)).toEqual(['delivered', 'delivered'])
  })

  test('a terminal that is not running is a missed run, and nothing is started', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    s.arm()
    s.host.running.delete('t')
    s.advance(MIN)
    expect(s.typed()).toEqual([])
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', detail: /wasn't running.*never starts/ })
  })

  test('editing disarms it, so the next slot does nothing', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    s.arm()
    s.store.dispatch({ op: 'patchNode', id: 'tr', patch: { prompt: 'rm -rf' } })
    s.advance(MIN)
    expect(s.typed()).toEqual([])
  })

  test('a slot found long after it was due is missed, not run late', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    s.arm()
    s.advance(MIN + LATE_LIMIT_MS + 1 + 2 * MIN)
    expect(s.typed()).toEqual([])
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', detail: /Skipped 3 runs/ })
    expect(s.trig().nextAt).toBeGreaterThan(clock)
  })

  test('run now fires an armed trigger without moving its schedule', () => {
    const s = setup([triggerNode('tr')])
    s.service.start()
    s.arm()
    const next = s.trig().nextAt
    expect(s.service.runNow('tr')).toMatchObject({ ok: true, run: { outcome: 'delivered', source: 'manual' } })
    expect(s.trig().nextAt).toBe(next)
  })

  test('a one-off runs once and is then disarmed', () => {
    const s = setup([triggerNode('tr', { schedule: { type: 'once', at: 1_000_000 + 5 * MIN } })])
    s.service.start()
    s.arm()
    s.advance(5 * MIN)
    s.advance(5 * MIN)
    expect(s.typed()).toHaveLength(1)
    expect(s.trig()).toMatchObject({ armedSpec: null, nextAt: null })
  })
})

/** A Claude target is typed into as one bracketed paste: see src/main/sessions/paste.ts. */
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`

describe('a Claude target', () => {
  test('gets the prompt at once when idle', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.idle()
    s.service.start()
    s.arm()
    s.advance(MIN)
    expect(s.typed()).toEqual([`t:${paste('check the build')}`])
    expect(s.trig().runs[0].outcome).toBe('delivered')
  })

  test('waits while it works, then delivers when it goes idle', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.idle()
    s.working()
    s.service.start()
    s.arm()
    s.advance(MIN)
    expect(s.typed()).toEqual([])
    expect(s.trig().runs[0].outcome).toBe('queued')
    s.tracker.apply('t', { type: 'hook', name: 'Stop' })
    expect(s.typed()).toEqual([`t:${paste('check the build')}`])
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered', detail: /once it was idle/ })
  })

  test('holds one prompt at a time, recording later slots as missed', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.idle()
    s.working()
    s.service.start()
    s.arm()
    s.advance(MIN)
    s.advance(MIN)
    expect(s.trig().runs.map((r) => r.outcome)).toEqual(['missed', 'queued'])
    s.tracker.apply('t', { type: 'hook', name: 'Stop' })
    expect(s.typed()).toHaveLength(1)
  })

  test('disarming drops what is waiting, so it is never delivered', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.idle()
    s.working()
    s.service.start()
    s.arm()
    s.advance(MIN)
    s.service.disarm('tr')
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', detail: /Dropped/ })
    s.tracker.apply('t', { type: 'hook', name: 'Stop' })
    expect(s.typed()).toEqual([])
  })

  test('editing drops what is waiting too, even if it is armed again', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.idle()
    s.working()
    s.service.start()
    s.arm()
    s.advance(MIN)
    s.store.dispatch({ op: 'patchNode', id: 'tr', patch: { prompt: 'other' } })
    s.arm()
    s.tracker.apply('t', { type: 'hook', name: 'Stop' })
    expect(s.typed()).toEqual([])
  })

  test('a target that ends while it waits makes the run missed', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.idle()
    s.working()
    s.service.start()
    s.arm()
    s.advance(MIN)
    s.tracker.apply('t', { type: 'process-exit' })
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', detail: /ended/ })
  })

  test('an exited Claude is missed, never started', () => {
    const s = setup([triggerNode('tr')], 'claude')
    s.tracker.apply('t', { type: 'process-exit' })
    s.service.start()
    s.arm()
    s.advance(MIN)
    expect(s.trig().runs[0].outcome).toBe('missed')
  })

  test('shares one queue with patchbay send, one message per idle', async () => {
    const store = memoryStore([claudeNode('me'), claudeNode('t', { openedBy: 'me' }), triggerNode('tr')])
    const tracker = createStatusTracker({ notify: () => {} })
    const host = fakeHost()
    host.running.add('t')
    const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 0, settleMs: 10 } })
    const verbs = createVerbs({ store, runner: fakeRunner(), tracker, host, gate: createAfterGate({ store, tracker, runner: fakeRunner() }), queue })
    const service = createTriggerService({ store, tracker, host, queue, now: () => clock })
    tracker.apply('t', { type: 'launched' })
    tracker.apply('t', { type: 'hook', name: 'SessionStart' })
    tracker.apply('t', { type: 'hook', name: 'UserPromptSubmit' })
    await verbs('me', 'send', { node: 't', text: 'from an agent' })
    service.start()
    service.arm('tr', canonicalSpec(store.get().nodes.find((n) => n.id === 'tr') as TriggerNode))
    service.runNow('tr')
    tracker.apply('t', { type: 'hook', name: 'Stop' })
    const typed = () => host.writes.filter(([, d]) => d !== '\r').map(([, d]) => d)
    // An agent's message says who sent it. A trigger's prompt goes as the person set it.
    const fromAgent = expect.stringMatching(/^\x1b\[200~\[Patchbay message from "me" \(node me\)\..*\]\nfrom an agent\x1b\[201~$/)
    expect(typed()).toEqual([fromAgent])
    vi.advanceTimersByTime(20)
    expect(typed()).toEqual([fromAgent, paste('check the build')])
  })
})

describe('while the app was closed', () => {
  test('slots that passed are recorded as one missed run, and none of them fire', () => {
    const t = triggerNode('tr')
    const armedAt = clock - 10 * MIN
    const s = setup([{ ...t, armedSpec: canonicalSpec(t), armedAt, nextAt: armedAt + MIN }])
    s.service.start()
    expect(s.typed()).toEqual([])
    expect(s.trig().runs).toHaveLength(1)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', detail: /Skipped 10 runs.*app was closed/ })
    expect(s.trig().nextAt).toBe(clock + MIN)
    s.advance(MIN)
    expect(s.typed()).toHaveLength(1)
  })

  test('a prompt still waiting when the app closed is shown as missed', () => {
    const t = triggerNode('tr', { runs: [{ id: 'r', at: 1, source: 'schedule', outcome: 'queued' }] })
    const s = setup([t])
    s.service.start()
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'missed', detail: /app closed/ })
  })

  test('a saved arming that no longer matches is cleared', () => {
    const s = setup([triggerNode('tr', { armedSpec: 'stale', nextAt: 5 })])
    s.service.start()
    expect(s.trig()).toMatchObject({ armedSpec: null, nextAt: null })
  })

  test('a one-off whose time passed is missed and disarmed', () => {
    const t = triggerNode('tr', { schedule: { type: 'once', at: clock - MIN } })
    const s = setup([{ ...t, armedSpec: canonicalSpec(t), armedAt: clock - 2 * MIN, nextAt: clock - MIN }])
    s.service.start()
    expect(s.trig().runs[0].outcome).toBe('missed')
    expect(s.trig().armedSpec).toBeNull()
  })
})

test('the timer fires a due trigger by itself', () => {
  const s = setup([triggerNode('tr', { schedule: { type: 'interval', everyMs: 5000 } })])
  s.service.start()
  s.arm()
  clock += 5000
  vi.advanceTimersByTime(5000)
  expect(s.typed()).toHaveLength(1)
  s.service.stop()
  clock += 5000
  vi.advanceTimersByTime(30_000)
  expect(s.typed()).toHaveLength(1)
})
