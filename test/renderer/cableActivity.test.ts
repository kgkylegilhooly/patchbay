import { expect, test } from 'vitest'
import { alignCableDots, alignCablesIn, cableUnderWay } from '../../src/renderer/cableActivity'
import { setCableMotion } from '../../src/renderer/cableMotion'

test("a cable's dots move while an agent at either end is starting, working or queued after the other", () => {
  expect(cableUnderWay({ status: 'working' }, { status: 'idle' })).toBe(true)
  expect(cableUnderWay({ status: 'idle' }, { status: 'working' })).toBe(true)
  expect(cableUnderWay({ status: null }, { status: 'starting' })).toBe(true)
  expect(cableUnderWay({ status: 'idle' }, { status: 'queued' })).toBe(true)
})

test('and while a run command at either end is running', () => {
  // An agent's "after" cable into npm test, say: the run node has no agent status, only its run.
  expect(cableUnderWay({ status: 'idle' }, { running: true })).toBe(true)
  expect(cableUnderWay({ running: true }, {})).toBe(true)
  expect(cableUnderWay({ status: 'idle' }, { running: false })).toBe(false)
})

test('with nothing under way at either end, the dots stand still', () => {
  expect(cableUnderWay({ status: 'idle' }, { status: 'idle' })).toBe(false)
  expect(cableUnderWay({ status: 'needs-you' }, { status: 'exited' })).toBe(false)
  expect(cableUnderWay({ status: undefined }, { status: 'unknown' })).toBe(false)
  // A terminal, a note or a trigger has no status and no run.
  expect(cableUnderWay({}, {})).toBe(false)
})

test('moving dots are put on the page timeline, so every cable steps in the same frame', () => {
  const running = { playState: 'running', startTime: 1234 as number | null }
  const paused = { playState: 'paused', startTime: null as number | null }
  alignCableDots({ getAnimations: () => [running, paused] })
  expect(running.startTime).toBe(0)
  // Setting a paused one's start would set it going while the view moves.
  expect(paused.startTime).toBeNull()
})

test('a cable with no dots drawn, or none moving, is left as it is', () => {
  expect(() => alignCableDots(null)).not.toThrow()
  expect(() => alignCableDots({})).not.toThrow()
  expect(() => alignCablesIn(null)).not.toThrow()
})

/** A stage holding moving cables, which records what it was asked for. */
function stage(animations: { playState: string; startTime: number | null }[]) {
  const attrs = new Set<string>()
  const asked: string[] = []
  const el = {
    toggleAttribute: (name: string, on: boolean) => void (on ? attrs.add(name) : attrs.delete(name)),
    querySelectorAll: (selector: string) => {
      asked.push(selector)
      return animations.map((a) => ({ getAnimations: () => [a] }))
    }
  }
  return { el: el as unknown as HTMLElement, attrs, asked }
}

test('when the view stops moving, a cable that turned busy meanwhile is put back on the beat', () => {
  const late = { playState: 'running', startTime: 4321 as number | null }
  const s = stage([late])
  setCableMotion(s.el, { moving: true, zoom: 1 })
  expect(s.attrs.has('data-canvas-moving')).toBe(true)
  expect(late.startTime).toBe(4321)
  setCableMotion(s.el, { moving: false, zoom: 1 })
  expect(s.attrs.has('data-canvas-moving')).toBe(false)
  expect(s.asked).toEqual(['.cable-flow:not(.cable-still)'])
  expect(late.startTime).toBe(0)
})

test('zoomed far out the cables stay paused, so nothing is aligned until they move again', () => {
  const late = { playState: 'running', startTime: 4321 as number | null }
  const s = stage([late])
  setCableMotion(s.el, { moving: false, zoom: 0.1 })
  expect(s.attrs.has('data-canvas-far')).toBe(true)
  expect(late.startTime).toBe(4321)
})
