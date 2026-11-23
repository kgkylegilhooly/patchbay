import { describe, expect, test, vi } from 'vitest'
import { afterNextPaint, createMountQueue } from '../../src/renderer/mountQueue'

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

test('a window about to get the keyboard is built before everything else waiting', () => {
  const { q, job, frame, built } = setup(40)
  q.request(true, job('on1'), 'on1')
  q.request(false, job('off1'), 'off1')
  q.request(false, job('target'), 'target')
  q.prioritize('target')
  frame()
  expect(built).toEqual(['target'])
  // Asking for one already built, or never asked for, changes nothing.
  q.prioritize('target')
  q.prioritize('nobody')
  frame()
  frame()
  expect(built).toEqual(['target', 'on1', 'off1'])
})

test('a prioritized window can still be cancelled', () => {
  const { q, job, frame, built } = setup(1)
  const cancel = q.request(false, job('gone'), 'gone')
  q.prioritize('gone')
  cancel()
  frame()
  expect(built).toEqual([])
})

describe('afterNextPaint', () => {
  function clock() {
    const frames: Array<() => void> = []
    const timers: Array<{ f: () => void; ms: number }> = []
    return {
      frame: (f: () => void) => frames.push(f),
      later: (f: () => void, ms: number) => timers.push({ f, ms }),
      /** The frame's animation callbacks, then (as after its paint) the tasks they queued. */
      paint() {
        for (const f of frames.splice(0)) f()
        for (const t of timers.filter((x) => x.ms === 0)) timers.splice(timers.indexOf(t), 1), t.f()
      },
      timeout() {
        for (const t of timers.splice(0)) t.f()
      }
    }
  }

  test('runs once the next frame has been drawn, not in it, and only once', () => {
    const c = clock()
    const cb = vi.fn()
    afterNextPaint(cb, c.frame, c.later)
    expect(cb).not.toHaveBeenCalled()
    c.paint()
    expect(cb).toHaveBeenCalledTimes(1)
    c.timeout()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('runs anyway when no frame comes, as in a minimized window', () => {
    const c = clock()
    const cb = vi.fn()
    afterNextPaint(cb, c.frame, c.later)
    c.timeout()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  test('cancelled, it never runs', () => {
    const c = clock()
    const cb = vi.fn()
    afterNextPaint(cb, c.frame, c.later)()
    c.paint()
    c.timeout()
    expect(cb).not.toHaveBeenCalled()
  })
})
