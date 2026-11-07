import { expect, test } from 'vitest'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { draftOf, fromLocalInput, intervalParts, nextLabel, relative, scheduleOf, toLocalInput, triggerState } from '../../src/renderer/triggerView'
import { triggerNode } from '../trigger/fixtures'

test('state is armed only while the content matches what was agreed', () => {
  const n = triggerNode('a')
  expect(triggerState(n)).toBe('disarmed')
  expect(triggerState({ ...n, armedSpec: canonicalSpec(n) })).toBe('armed')
  expect(triggerState({ ...n, armedSpec: 'old' })).toBe('disarmed')
  const once = triggerNode('b', { schedule: { type: 'once', at: 1 }, runs: [{ id: 'r', at: 1, source: 'schedule', outcome: 'delivered' }] })
  expect(triggerState(once)).toBe('done')
})

test('the next run reads as a time and how soon', () => {
  const n = triggerNode('a')
  expect(nextLabel(n, 0)).toMatch(/Arm it/)
  const armed = { ...n, armedSpec: canonicalSpec(n), nextAt: 125_000 }
  expect(nextLabel(armed, 120_000)).toMatch(/\(in 5 s\)$/)
  expect(nextLabel({ ...armed, nextAt: null }, 0)).toBe('No more runs.')
  expect(relative(90 * 60_000)).toBe('in 2 h')
  expect(relative(3 * 86_400_000)).toBe('in 3 days')
})

test('a schedule goes into the form and back unchanged', () => {
  for (const s of [{ type: 'interval' as const, everyMs: 90_000 }, { type: 'interval' as const, everyMs: 7_200_000 }, { type: 'cron' as const, expr: '*/5 * * * *' }]) {
    expect(scheduleOf(draftOf(s, 0))).toEqual(s)
  }
  const at = new Date(2026, 10, 5, 14, 30).getTime()
  expect(scheduleOf(draftOf({ type: 'once', at }, 0))).toEqual({ type: 'once', at })
  expect(intervalParts(5000)).toEqual({ amount: 5, unit: 'seconds' })
  expect(fromLocalInput(toLocalInput(at))).toBe(at)
  expect(fromLocalInput('nonsense')).toBeNaN()
  expect(scheduleOf({ ...draftOf({ type: 'interval', everyMs: 60_000 }, 0), amount: '' })).toMatchObject({ everyMs: NaN })
})
