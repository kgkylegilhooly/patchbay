import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createAgentStops } from '../../src/main/sessions/agentStops'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTriggerService } from '../../src/main/triggers/service'
import { heldReason, RELEASE_MARGIN_MS } from '../../src/shared/agentStop'
import type { TriggerNode } from '../../src/shared/model'
import { claudeNode, fakeHost, memoryStore } from '../control/fakes'
import { triggerNode } from './fixtures'

const START = new Date(2026, 10, 19, 21, 40).getTime()
const RESET = new Date(2026, 10, 20, 0, 30).getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => vi.useRealTimers())

test('a trigger firing at a node stopped at its usage limit is held until the reset, and its run says so', () => {
  const store = memoryStore([claudeNode('t', { title: 'Builder' }), triggerNode('tr', { schedule: { type: 'interval', everyMs: 86_400_000 } })])
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  host.running.add('t')
  const stops = createAgentStops({ tracker })
  const queue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), timing: { enterDelayMs: 0, settleMs: 10 }, hold: stops })
  const held = (id: string): string | undefined => {
    const stop = tracker.get(id) === 'unknown' ? stops.get(id) : undefined
    return (stop && heldReason(stop, Date.now())) ?? undefined
  }
  const service = createTriggerService({ store, tracker, host, queue, held })
  const trig = () => store.get().nodes.find((n) => n.id === 'tr') as TriggerNode
  tracker.apply('t', { type: 'launched' })
  tracker.apply('t', { type: 'hook', name: 'SessionStart' })
  tracker.apply('t', { type: 'hook', name: 'UserPromptSubmit' })
  tracker.apply('t', { type: 'hook', name: 'StopFailure' })
  stops.noteHook('t', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" })
  service.start()
  expect(service.arm('tr', canonicalSpec(trig()))).toEqual({ ok: true })

  expect(service.runNow('tr')).toMatchObject({ ok: true, run: { outcome: 'queued', detail: 'Held: "Builder" stopped (Usage limit until 00:30. It goes out then)' } })
  vi.advanceTimersByTime(RESET - START)
  expect(host.writes).toEqual([])
  vi.advanceTimersByTime(RELEASE_MARGIN_MS)
  expect(host.writes.map(([, d]) => d.replace(/\x1b\[20[01]~/g, ''))).toContain('check the build')
  expect(trig().runs.find((r) => r.source === 'manual')).toMatchObject({ outcome: 'delivered' })
  service.stop()
})
