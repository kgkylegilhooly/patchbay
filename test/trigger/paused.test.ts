import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTriggerService } from '../../src/main/triggers/service'
import type { TriggerNode } from '../../src/shared/model'
import { fakeHost, memoryStore, terminalNode } from '../control/fakes'
import { triggerNode } from './fixtures'

const MIN = 60_000
let clock = 0
beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000_000
})
afterEach(() => vi.useRealTimers())

// F54: before a meeting, or while fixing something by hand, every armed trigger had to be disarmed and armed again.
test('while all triggers are paused, a due one sends nothing and says why; it stays armed, and runs again once unpaused', () => {
  let paused = true
  const store = memoryStore([terminalNode('t'), triggerNode('tr')])
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('t')
  const queue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), timing: { enterDelayMs: 0, settleMs: 10 } })
  const service = createTriggerService({ store, tracker, host, queue, now: () => clock, paused: () => paused })
  const trig = () => store.get().nodes.find((n) => n.id === 'tr') as TriggerNode
  const typed = () => host.writes.filter(([, d]) => d !== '\r').map(([, d]) => d)
  service.start()
  expect(service.arm('tr', canonicalSpec(trig()))).toEqual({ ok: true })
  clock += MIN
  service.tick()
  clock += MIN
  service.tick()
  expect(typed()).toEqual([])
  // Recorded once, not once per slot: a long pause doesn't fill the history.
  expect(trig().runs.map((r) => [r.outcome, r.detail])).toEqual([['skipped', 'All triggers are paused.']])
  expect(trig().armedSpec).not.toBeNull()
  // Run now is the person asking, so it goes even while paused.
  expect(service.runNow('tr')).toMatchObject({ ok: true, run: { outcome: 'delivered' } })
  paused = false
  clock += MIN
  service.tick()
  expect(typed()).toEqual(['check the build', 'check the build'])
})
