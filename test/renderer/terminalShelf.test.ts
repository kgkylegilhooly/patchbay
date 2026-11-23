import { expect, test, vi } from 'vitest'
import { createTerminalShelf } from '../../src/renderer/terminalShelf'

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
