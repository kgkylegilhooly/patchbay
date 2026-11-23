import { expect, test } from 'vitest'
import { applySight, type Sighted } from '../../src/renderer/cableSight'

function cable(off = false, playState = 'running'): Sighted & { classes: Set<string>; animation: { playState: string; startTime: CSSNumberish | null } } {
  const classes = new Set<string>(off ? ['cable-off'] : [])
  const animation = { playState, startTime: 480 as CSSNumberish | null }
  return {
    classes,
    animation,
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)), contains: (name: string) => classes.has(name) },
    getAnimations: () => [animation]
  }
}

test('a cable leaving the screen has its dots paused; one coming back moves again', () => {
  const a = cable()
  applySight([{ target: a, isIntersecting: false }])
  expect(a.classes.has('cable-off')).toBe(true)
  applySight([{ target: a, isIntersecting: true }])
  expect(a.classes.has('cable-off')).toBe(false)
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
