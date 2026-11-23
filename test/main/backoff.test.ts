import { afterEach, expect, test, vi } from 'vitest'
import { backoffInterval } from '../../src/main/backoff'

afterEach(() => vi.useRealTimers())

test('a check that finds nothing slows down to its limit, and runs far fewer times', () => {
  vi.useFakeTimers()
  let runs = 0
  const b = backoffInterval(() => (runs++, false), 1000, 8000)
  vi.advanceTimersByTime(30_000)
  // Every second would be 30. Doubling to 8 s: 1, 2, 4, 8, 8, 8 ... in 30 s.
  expect(runs).toBeLessThanOrEqual(7)
  expect(b.everyMs()).toBe(8000)
  b.close()
})

test('finding something keeps it at its base, and wake brings it straight back', () => {
  vi.useFakeTimers()
  let found = true
  let runs = 0
  const b = backoffInterval(() => (runs++, found), 1000, 8000)
  vi.advanceTimersByTime(5000)
  expect(runs).toBe(5)
  expect(b.everyMs()).toBe(1000)
  found = false
  vi.advanceTimersByTime(20_000)
  expect(b.everyMs()).toBe(8000)
  b.wake()
  expect(b.everyMs()).toBe(1000)
  const at = runs
  vi.advanceTimersByTime(1000)
  expect(runs).toBe(at + 1)
  b.close()
  vi.advanceTimersByTime(60_000)
  expect(runs).toBe(at + 1)
})

test('an async check, or one that throws, still settles the pace', async () => {
  vi.useFakeTimers()
  let runs = 0
  const b = backoffInterval(async () => {
    runs++
    if (runs === 1) throw new Error('read failed')
    return false
  }, 100, 400)
  await vi.advanceTimersByTimeAsync(2000)
  expect(b.everyMs()).toBe(400)
  b.close()
})
