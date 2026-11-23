import { expect, test, vi } from 'vitest'
import { createTerminalShelf, SETTLE_MS } from '../../src/renderer/terminalShelf'

function fakeTimers() {
  const due: Array<{ cb: () => void; ms: number; live: boolean }> = []
  return {
    due,
    timers: {
      set: (cb: () => void, ms: number) => {
        const t = { cb, ms, live: true }
        due.push(t)
        return t
      },
      clear: (t: unknown) => {
        if (t) (t as { live: boolean }).live = false
      }
    },
    fireAll: () => {
      for (const t of due.splice(0)) if (t.live) t.cb()
    },
    /** Only what's due straight away (the budget check), not the keep timers. */
    settle: () => {
      for (const t of due.filter((x) => x.ms === SETTLE_MS)) {
        due.splice(due.indexOf(t), 1)
        if (t.live) t.cb()
      }
    }
  }
}

test('a window drawn again takes back the terminal it had, with nothing built or replayed', () => {
  const dispose = vi.fn()
  const { timers } = fakeTimers()
  const shelf = createTerminalShelf<string>(dispose, () => 1000, timers)
  shelf.keep('a', { value: 'term-a', key: '0:0', projectId: 'p1' }, 'p2')
  expect(shelf.take('a', '0:0')).toBe('term-a')
  expect(shelf.take('a', '0:0')).toBeNull()
  expect(dispose).not.toHaveBeenCalled()
})

test('a restarted or refreshed session never gets the old terminal: it is let go', () => {
  const dispose = vi.fn()
  const shelf = createTerminalShelf<string>(dispose, () => 1000, fakeTimers().timers)
  shelf.keep('a', { value: 'old', key: '0:0', projectId: 'p1' }, 'p2')
  expect(shelf.take('a', '1:0')).toBeNull()
  expect(dispose).toHaveBeenCalledWith('old')
  expect(shelf.ids()).toEqual([])
})

test('only the project just left is kept: leaving a third lets the first go', () => {
  const dispose = vi.fn()
  const shelf = createTerminalShelf<string>(dispose, () => 1000, fakeTimers().timers)
  shelf.keep('a', { value: 'a', key: 'k', projectId: 'p1' }, 'p2')
  shelf.keep('b', { value: 'b', key: 'k', projectId: 'p1' }, 'p2')
  expect(shelf.ids().sort()).toEqual(['a', 'b'])
  // p2 -> p3: p2's are kept, p1's go.
  shelf.keep('c', { value: 'c', key: 'k', projectId: 'p2' }, 'p3')
  expect(shelf.ids()).toEqual(['c'])
  expect(dispose.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
})

test('a window moved within the project on show (maximized, a Focus view pane) keeps the project just left', () => {
  const dispose = vi.fn()
  const shelf = createTerminalShelf<string>(dispose, () => 1000, fakeTimers().timers)
  shelf.keep('a', { value: 'a', key: 'k', projectId: 'p1' }, 'p2')
  shelf.keep('m', { value: 'm', key: 'k', projectId: 'p2' }, 'p2')
  expect(shelf.ids().sort()).toEqual(['a', 'm'])
  expect(dispose).not.toHaveBeenCalled()
})

test('a kept terminal goes after a while, and all go at once when memory is short', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<string>(dispose, () => 180_000, t.timers)
  shelf.keep('a', { value: 'a', key: 'k', projectId: 'p1' }, 'p2')
  expect(t.due[0].ms).toBe(180_000)
  t.fireAll()
  expect(dispose).toHaveBeenCalledWith('a')
  expect(shelf.ids()).toEqual([])
  shelf.keep('b', { value: 'b', key: 'k', projectId: 'p1' }, 'p2')
  shelf.keep('c', { value: 'c', key: 'k', projectId: 'p1' }, 'p2')
  shelf.clear()
  expect(dispose).toHaveBeenCalledTimes(3)
})

test('a terminal taken back is not let go by its old timer', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<string>(dispose, () => 1000, t.timers)
  shelf.keep('a', { value: 'a', key: 'k', projectId: 'p1' }, 'p2')
  shelf.take('a', 'k')
  t.fireAll()
  expect(dispose).not.toHaveBeenCalled()
})

test('keeping one twice lets the first copy go', () => {
  const dispose = vi.fn()
  const shelf = createTerminalShelf<string>(dispose, () => 1000, fakeTimers().timers)
  shelf.keep('a', { value: 'first', key: 'k', projectId: 'p1' }, 'p2')
  shelf.keep('a', { value: 'second', key: 'k', projectId: 'p1' }, 'p2')
  expect(dispose).toHaveBeenCalledWith('first')
  expect(shelf.take('a', 'k')).toBe('second')
})

const budget = (maxCount: number, maxBytes: number) => ({ maxCount, maxBytes, weigh: (v: { mb: number }) => v.mb * 1024 * 1024 })

test('past the count, the terminal kept longest ago goes first', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<{ name: string; mb: number }>(dispose, () => 1000, t.timers, budget(2, 1e12))
  for (const name of ['a', 'b', 'c']) shelf.keep(name, { value: { name, mb: 1 }, key: 'k', projectId: 'p1' }, 'p2')
  t.settle()
  expect(shelf.ids()).toEqual(['b', 'c'])
  expect(dispose.mock.calls.map((c) => c[0].name)).toEqual(['a'])
})

test('past the size, the oldest go until what is kept fits', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<{ name: string; mb: number }>(dispose, () => 1000, t.timers, budget(10, 100 * 1024 * 1024))
  shelf.keep('a', { value: { name: 'a', mb: 40 }, key: 'k', projectId: 'p1' }, 'p2')
  shelf.keep('b', { value: { name: 'b', mb: 40 }, key: 'k', projectId: 'p1' }, 'p2')
  t.settle()
  expect(shelf.bytes()).toBe(80 * 1024 * 1024)
  shelf.keep('c', { value: { name: 'c', mb: 50 }, key: 'k', projectId: 'p1' }, 'p2')
  t.settle()
  // 130 MB: a goes, leaving 90.
  expect(shelf.ids()).toEqual(['b', 'c'])
  expect(shelf.bytes()).toBe(90 * 1024 * 1024)
})

test('one terminal bigger than the whole budget is not kept at all', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<{ name: string; mb: number }>(dispose, () => 1000, t.timers, budget(10, 100 * 1024 * 1024))
  shelf.keep('huge', { value: { name: 'huge', mb: 200 }, key: 'k', projectId: 'p1' }, 'p2')
  t.settle()
  expect(shelf.ids()).toEqual([])
  expect(dispose).toHaveBeenCalledTimes(1)
})

test('a switch keeps the project left before it takes back the one shown: none taken back is let go for the budget', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<{ name: string; mb: number }>(dispose, () => 1000, t.timers, budget(3, 1e12))
  // p2's two were kept when p2 was left.
  for (const name of ['x', 'y']) shelf.keep(name, { value: { name, mb: 1 }, key: 'k', projectId: 'p2' }, 'p1')
  t.settle()
  // Back to p2: p1's two go on the shelf first (four, one over), then p2's are taken back, all in one commit.
  for (const name of ['a', 'b']) shelf.keep(name, { value: { name, mb: 1 }, key: 'k', projectId: 'p1' }, 'p2')
  expect(shelf.take('x', 'k')?.name).toBe('x')
  expect(shelf.take('y', 'k')?.name).toBe('y')
  t.settle()
  expect(dispose).not.toHaveBeenCalled()
  expect(shelf.ids()).toEqual(['a', 'b'])
})

test('the budget is checked once for a batch of keeps, after it', () => {
  const dispose = vi.fn()
  const t = fakeTimers()
  const shelf = createTerminalShelf<{ name: string; mb: number }>(dispose, () => 1000, t.timers, budget(2, 1e12))
  for (const name of ['a', 'b', 'c', 'd']) shelf.keep(name, { value: { name, mb: 1 }, key: 'k', projectId: 'p1' }, 'p2')
  expect(t.due.filter((x) => x.ms === SETTLE_MS)).toHaveLength(1)
  expect(shelf.ids()).toHaveLength(4)
  t.settle()
  expect(shelf.ids()).toEqual(['c', 'd'])
})

test('the check waits for whatever the budget says has settled, as the app waits for frames after the timer', () => {
  const dispose = vi.fn()
  let due: (() => void) | null = null
  const shelf = createTerminalShelf<{ name: string; mb: number }>(dispose, () => 1000, fakeTimers().timers, { ...budget(1, 1e12), settle: (check) => (due = check) })
  for (const name of ['a', 'b']) shelf.keep(name, { value: { name, mb: 1 }, key: 'k', projectId: 'p1' }, 'p2')
  expect(shelf.ids()).toEqual(['a', 'b'])
  due!()
  expect(shelf.ids()).toEqual(['b'])
})
