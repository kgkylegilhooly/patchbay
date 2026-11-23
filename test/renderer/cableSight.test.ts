import { expect, test } from 'vitest'
import { applySight, OFF, type Sighted } from '../../src/renderer/cableSight'

/** A dots path as the page has it: React's class attribute and other attributes kept apart, as in the DOM. */
function cable(off = false, playState = 'running') {
  const attrs = new Set<string>(off ? [OFF] : [])
  const animation = { playState, startTime: 480 as CSSNumberish | null }
  const el = {
    className: 'cable-flow cable-still',
    attrs,
    animation,
    toggleAttribute: (name: string, on: boolean) => (on ? attrs.add(name) : attrs.delete(name)),
    hasAttribute: (name: string) => attrs.has(name),
    getAnimations: () => [animation]
  }
  return el satisfies Sighted
}

test('a cable leaving the screen has its dots paused; one coming back moves again', () => {
  const a = cable()
  applySight([{ target: a, isIntersecting: false }])
  expect(a.attrs.has(OFF)).toBe(true)
  applySight([{ target: a, isIntersecting: true }])
  expect(a.attrs.has(OFF)).toBe(false)
})

test('an off-screen cable that turns busy stays paused: React writing its class leaves the mark alone', () => {
  const a = cable()
  applySight([{ target: a, isIntersecting: false }])
  // Its agent starts working: CableEdge renders className="cable-flow" (no longer cable-still).
  a.className = 'cable-flow'
  expect(a.attrs.has(OFF)).toBe(true)
  // Back on screen, it's marked off still, so it joins the beat.
  applySight([{ target: a, isIntersecting: true }])
  expect(a.animation.startTime).toBe(0)
})

test('back on screen, a moving cable joins the beat every other cable steps to', () => {
  const back = cable(true)
  applySight([{ target: back, isIntersecting: true }])
  expect(back.animation.startTime).toBe(0)
})

test('a cable that was on screen all along is left on its beat, and a still one stays still', () => {
  const steady = cable(false)
  applySight([{ target: steady, isIntersecting: true }])
  expect(steady.animation.startTime).toBe(480)
  const still = cable(true, 'paused')
  applySight([{ target: still, isIntersecting: true }])
  expect(still.animation.startTime).toBe(480)
})
