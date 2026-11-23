import { expect, test } from 'vitest'
import { createMountQueue } from '../../src/renderer/mountQueue'

function setup(costMs: number, budgetMs = 8) {
  let clock = 0
  const frames: Array<() => void> = []
  const built: string[] = []
  const q = createMountQueue((cb) => frames.push(cb), () => clock, budgetMs)
  const job = (id: string) => () => {
    built.push(id)
    clock += costMs
  }
  const frame = () => frames.shift()?.()
  return { q, job, frame, built, frames }
}

test('nothing is built in the frame that asked: the window draws first', () => {
  const { q, job, built, frames } = setup(1)
  q.request(true, job('a'))
  expect(built).toEqual([])
  expect(frames).toHaveLength(1)
})

test('those on screen are built first, then the rest, as many a frame as the budget allows', () => {
  const { q, job, frame, built } = setup(3)
  q.request(false, job('off1'))
  q.request(true, job('on1'))
  q.request(false, job('off2'))
  q.request(true, job('on2'))
  frame()
  // 3 ms each against 8 ms: three fit.
  expect(built).toEqual(['on1', 'on2', 'off1'])
  frame()
  expect(built).toEqual(['on1', 'on2', 'off1', 'off2'])
  expect(q.pending()).toBe(0)
})

test('a costly build still goes one a frame, never none', () => {
  const { q, job, frame, built, frames } = setup(40)
  for (const id of ['a', 'b', 'c']) q.request(true, job(id))
  frame()
  expect(built).toEqual(['a'])
  expect(frames).toHaveLength(1)
  frame()
  frame()
  expect(built).toEqual(['a', 'b', 'c'])
  expect(frames).toHaveLength(0)
})

test('a window gone before its turn is never built', () => {
  const { q, job, frame, built } = setup(1)
  const cancel = q.request(true, job('gone'))
  q.request(true, job('kept'))
  cancel()
  frame()
  expect(built).toEqual(['kept'])
  // Cancelling after the build does nothing.
  cancel()
  expect(q.pending()).toBe(0)
})
