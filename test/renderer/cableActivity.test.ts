import { expect, test } from 'vitest'
import { alignCableDots, cableUnderWay } from '../../src/renderer/cableActivity'

test("a cable's dots move while a node at either end is starting, working or queued after the other", () => {
  expect(cableUnderWay('working', 'idle')).toBe(true)
  expect(cableUnderWay('idle', 'working')).toBe(true)
  expect(cableUnderWay(null, 'starting')).toBe(true)
  expect(cableUnderWay('idle', 'queued')).toBe(true)
})

test('with nothing under way at either end, the dots stand still', () => {
  expect(cableUnderWay('idle', 'idle')).toBe(false)
  expect(cableUnderWay('needs-you', 'exited')).toBe(false)
  expect(cableUnderWay(undefined, 'unknown')).toBe(false)
  // A terminal, a note or a trigger has no status.
  expect(cableUnderWay(null, undefined)).toBe(false)
})

test('moving dots are put on the page timeline, so every cable steps in the same frame', () => {
  const running = { playState: 'running', startTime: 1234 as number | null }
  const paused = { playState: 'paused', startTime: null as number | null }
  alignCableDots({ getAnimations: () => [running, paused] })
  expect(running.startTime).toBe(0)
  // A paused one is in step with the rest when they all resume together.
  expect(paused.startTime).toBeNull()
})

test('a cable with no dots drawn, or none moving, is left as it is', () => {
  expect(() => alignCableDots(null)).not.toThrow()
  expect(() => alignCableDots({})).not.toThrow()
})
