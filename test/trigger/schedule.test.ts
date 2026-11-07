import { describe, expect, test } from 'vitest'
import { describeInterval, describeSchedule, nextRun, nextRuns, scheduleError, slotsUpTo } from '../../src/core/trigger/schedule'

const MIN = 60_000

describe('scheduleError', () => {
  test('passes good schedules', () => {
    expect(scheduleError({ type: 'cron', expr: '0 9 * * 1-5' })).toBeNull()
    expect(scheduleError({ type: 'interval', everyMs: 5000 })).toBeNull()
    expect(scheduleError({ type: 'once', at: 0 })).toBeNull()
  })

  test('says what is wrong', () => {
    expect(scheduleError({ type: 'cron', expr: 'nonsense' })).toMatch(/5 fields/)
    expect(scheduleError({ type: 'cron', expr: '0 0 30 2 *' })).toMatch(/never matches/)
    expect(scheduleError({ type: 'interval', everyMs: 4999 })).toMatch(/at least 5 seconds/)
    expect(scheduleError({ type: 'interval', everyMs: NaN })).toMatch(/interval/)
    expect(scheduleError({ type: 'once', at: NaN })).toMatch(/date/)
  })
})

describe('nextRun', () => {
  test('interval slots count from when it was armed, whatever time it asks from', () => {
    const s = { type: 'interval' as const, everyMs: 10 * MIN }
    expect(nextRun(s, 1000, 1000)).toBe(1000 + 10 * MIN)
    expect(nextRun(s, 1000 + 10 * MIN, 1000)).toBe(1000 + 20 * MIN)
    expect(nextRun(s, 1000 + 25 * MIN, 1000)).toBe(1000 + 30 * MIN)
    expect(nextRun(s, 0, 1000)).toBe(1000 + 10 * MIN)
  })

  test('a one-off runs once, and then has nothing left', () => {
    const s = { type: 'once' as const, at: 5000 }
    expect(nextRun(s, 4999, 0)).toBe(5000)
    expect(nextRun(s, 5000, 0)).toBeNull()
  })

  test('a broken cron has no runs rather than throwing', () => {
    expect(nextRun({ type: 'cron', expr: 'x' }, 0, 0)).toBeNull()
  })

  test('nextRuns lists the next few, stopping when there are no more', () => {
    expect(nextRuns({ type: 'interval', everyMs: MIN }, 0, 0, 3)).toEqual([MIN, 2 * MIN, 3 * MIN])
    expect(nextRuns({ type: 'once', at: 10 }, 0, 0, 3)).toEqual([10])
  })
})

describe('slotsUpTo', () => {
  test('counts every slot from the first one due to now', () => {
    const s = { type: 'interval' as const, everyMs: MIN }
    expect(slotsUpTo(s, MIN, 3.5 * MIN, 0)).toEqual({ count: 3, last: 3 * MIN, capped: false })
    expect(slotsUpTo(s, MIN, MIN, 0)).toEqual({ count: 1, last: MIN, capped: false })
  })

  test('stops counting at a limit', () => {
    const r = slotsUpTo({ type: 'interval', everyMs: 5000 }, 5000, 1e12, 0)
    expect(r.capped).toBe(true)
    expect(r.count).toBe(1000)
  })

  test('a one-off is one slot', () => {
    expect(slotsUpTo({ type: 'once', at: 5 }, 5, 1e9, 0).count).toBe(1)
  })
})

describe('describing', () => {
  test('intervals in the largest whole unit', () => {
    expect(describeInterval(5000)).toBe('Every 5 seconds')
    expect(describeInterval(MIN)).toBe('Every minute')
    expect(describeInterval(90 * MIN)).toBe('Every 90 minutes')
    expect(describeInterval(2 * 3_600_000)).toBe('Every 2 hours')
    expect(describeInterval(86_400_000)).toBe('Every day')
  })

  test('a cron schedule is shown as written, tidied, with its time zone', () => {
    expect(describeSchedule({ type: 'cron', expr: ' 0  9 * * 1-5 ' })).toBe('Cron: 0 9 * * 1-5 (local time)')
  })
})
