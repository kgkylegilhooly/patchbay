import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { nextCron, parseCron, type Cron } from '../../src/core/trigger/cron'

const cron = (expr: string): Cron => {
  const r = parseCron(expr)
  if (!r.ok) throw new Error(r.error)
  return r.cron
}
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const next = (expr: string, from: number) => {
  const t = nextCron(cron(expr), from)
  return t === null ? null : new Date(t)
}
const fields = (d: Date | null) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)

describe('parseCron', () => {
  test('reads stars, numbers, lists, ranges and steps', () => {
    const c = cron('*/15 9-17 1,15 * 1-5')
    expect(sorted(c.minutes)).toEqual([0, 15, 30, 45])
    expect(sorted(c.hours)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(sorted(c.days)).toEqual([1, 15])
    expect(c.months.size).toBe(12)
    expect(sorted(c.weekdays)).toEqual([1, 2, 3, 4, 5])
  })

  test('steps over a range, and from a start to the end of the field', () => {
    expect(sorted(cron('10-30/10 * * * *').minutes)).toEqual([10, 20, 30])
    expect(sorted(cron('50/5 * * * *').minutes)).toEqual([50, 55])
  })

  test('takes month and weekday names in any case, alone and in ranges', () => {
    const c = cron('0 0 * JAN,mar-May Mon-Fri')
    expect(sorted(c.months)).toEqual([1, 3, 4, 5])
    expect(sorted(c.weekdays)).toEqual([1, 2, 3, 4, 5])
    expect(sorted(cron('0 0 * * sat,sun').weekdays)).toEqual([0, 6])
  })

  test('Sunday is 0 or 7, and can end a range', () => {
    expect(sorted(cron('0 0 * * 7').weekdays)).toEqual([0])
    expect(sorted(cron('0 0 * * 5-7').weekdays)).toEqual([0, 5, 6])
    expect(sorted(cron('0 0 * * mon-sun').weekdays)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test('a name can start a step', () => {
    expect(sorted(cron('0 0 * * mon/2').weekdays)).toEqual([0, 1, 3, 5])
  })

  test('tolerates extra spaces around and between fields', () => {
    expect(parseCron('  0   9 * *   * ').ok).toBe(true)
  })

  test('a field starting with a star does not count as restricted', () => {
    const c = cron('0 0 */2 * 1')
    expect(c.dayRestricted).toBe(false)
    expect(c.weekdayRestricted).toBe(true)
  })

  test.each([
    ['', /5 fields/],
    ['* * * *', /5 fields.*4/],
    ['* * * * * *', /5 fields.*6/],
    ['60 * * * *', /minute.*0 to 59/],
    ['* 24 * * *', /hour.*0 to 23/],
    ['* * 0 * *', /day of month.*1 to 31/],
    ['* * 32 * *', /day of month/],
    ['* * * 13 *', /month.*1 to 12/],
    ['* * * * 8', /day of week.*0 to 7/],
    ['*/0 * * * *', /step.*above 0/],
    ['*/x * * * *', /step/],
    ['1/2/3 * * * *', /more than one step/],
    ['5-1 * * * *', /backward/],
    ['1-2-3 * * * *', /bad range/],
    ['1,,2 * * * *', /empty item/],
    ['a * * * *', /isn't a number.$/],
    ['* * * foo *', /isn't a number or a name/],
    ['@daily', /5 fields/],
    ['-5 * * * *', /isn't a number|range/],
    ['1.5 * * * *', /isn't a number/]
  ])('refuses %j', (expr, message) => {
    const r = parseCron(expr)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(message)
  })
})

describe('nextCron', () => {
  test('is strictly after the given time, at a whole minute', () => {
    expect(fields(next('* * * * *', at(2026, 3, 2, 10, 0)))).toEqual([2026, 3, 2, 10, 1])
    expect(fields(next('* * * * *', at(2026, 3, 2, 10, 0) + 30_000))).toEqual([2026, 3, 2, 10, 1])
    expect(next('* * * * *', at(2026, 3, 2, 10, 0))!.getSeconds()).toBe(0)
  })

  test('finds the next weekday morning', () => {
    // 2026-03-06 is a Friday.
    expect(fields(next('0 9 * * 1-5', at(2026, 3, 6, 9, 0)))).toEqual([2026, 3, 9, 9, 0])
    expect(fields(next('0 9 * * 1-5', at(2026, 3, 6, 8, 59)))).toEqual([2026, 3, 6, 9, 0])
  })

  test('rolls over the hour, day, month and year', () => {
    expect(fields(next('30 * * * *', at(2026, 3, 2, 10, 45)))).toEqual([2026, 3, 2, 11, 30])
    expect(fields(next('0 0 * * *', at(2026, 12, 31, 12)))).toEqual([2027, 1, 1, 0, 0])
    expect(fields(next('0 0 1 * *', at(2026, 1, 15)))).toEqual([2026, 2, 1, 0, 0])
  })

  test('skips months too short for the day', () => {
    expect(fields(next('0 0 31 * *', at(2026, 4, 1)))).toEqual([2026, 5, 31, 0, 0])
  })

  test('day of month and day of week match either way when both are given', () => {
    // The 13th, or any Friday. 2026-03-06 is a Friday.
    expect(fields(next('0 0 13 * 5', at(2026, 3, 1)))).toEqual([2026, 3, 6, 0, 0])
    expect(fields(next('0 0 13 * 5', at(2026, 3, 10)))).toEqual([2026, 3, 13, 0, 0])
  })

  test('with a starred day of month, only the weekday counts', () => {
    expect(fields(next('0 0 */2 * 5', at(2026, 3, 1)))).toEqual([2026, 3, 13, 0, 0])
  })

  test('finds a leap day years away', () => {
    expect(fields(next('0 0 29 2 *', at(2026, 3, 1)))).toEqual([2028, 2, 29, 0, 0])
  })

  test('says never for a date that cannot exist', () => {
    expect(next('0 0 30 2 *', at(2026, 1, 1))).toBeNull()
    expect(next('0 0 31 4,6,9,11 *', at(2026, 1, 1))).toBeNull()
  })
})

describe('nextCron in a zone with daylight saving', () => {
  const was = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })
  afterAll(() => {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  })

  test('a time in the hour that clocks skip does not run that day', () => {
    // 2026-03-08 02:00 becomes 03:00 in New York.
    expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).toBe(240)
    expect(fields(next('30 2 * * *', at(2026, 3, 8, 0)))).toEqual([2026, 3, 9, 2, 30])
  })

  test('a time in the hour that clocks repeat runs in both', () => {
    // 2026-11-01 02:00 goes back to 01:00.
    const first = nextCron(cron('30 1 * * *'), at(2026, 11, 1, 0))!
    const second = nextCron(cron('30 1 * * *'), first)!
    expect(second - first).toBe(3_600_000)
    expect(fields(new Date(second))).toEqual([2026, 11, 1, 1, 30])
  })

  test('hourly runs keep going across both changes', () => {
    const spring = nextCron(cron('0 * * * *'), at(2026, 3, 8, 1, 30))!
    expect(fields(new Date(spring))).toEqual([2026, 3, 8, 3, 0])
  })
})
