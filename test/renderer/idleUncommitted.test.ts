import { expect, test } from 'vitest'
import { CHECK_EVERY_MS, IDLE_FOR_MS, chipLabel, dueForCheck, nextIdleSince } from '../../src/renderer/idleUncommitted'

const min = 60_000

// F52: an agent finishes, the person moves on, and its edits sit uncommitted until something overwrites them.
test('idle time counts from when an agent became idle, and any other status forgets it', () => {
  let since = nextIdleSince({}, { a: 'working', b: 'idle' }, 1000)
  expect(since).toEqual({ b: 1000 })
  since = nextIdleSince(since, { a: 'idle', b: 'idle' }, 5000)
  expect(since).toEqual({ a: 5000, b: 1000 })
  since = nextIdleSince(since, { a: 'idle', b: 'working' }, 9000)
  expect(since).toEqual({ a: 5000 })
})

test('an agent is looked at once it has been idle 30 minutes, then at most every 5', () => {
  const now = 100 * min
  expect(dueForCheck(now, now - IDLE_FOR_MS + 1, undefined)).toBe(false)
  expect(dueForCheck(now, now - IDLE_FOR_MS, undefined)).toBe(true)
  expect(dueForCheck(now, now - 60 * min, now - CHECK_EVERY_MS + 1)).toBe(false)
  expect(dueForCheck(now, now - 60 * min, now - CHECK_EVERY_MS)).toBe(true)
})

test('the chip says how many of its edits are uncommitted and for how long it has been idle', () => {
  expect(chipLabel(['src/a.ts'], 35 * min)).toBe('1 file uncommitted, idle 35 min')
  expect(chipLabel(['a', 'b', 'c'], 125 * min)).toBe('3 files uncommitted, idle 2 h')
})
