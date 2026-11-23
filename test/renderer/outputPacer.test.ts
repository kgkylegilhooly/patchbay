import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createOutputPacer } from '../../src/renderer/outputPacer'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('the window being typed in gets its output at once, so echo is never held up', () => {
  const out: string[] = []
  const pacer = createOutputPacer((d) => out.push(d), () => true, 100)
  pacer.write('a')
  pacer.write('b')
  expect(out).toEqual(['a', 'b'])
})

test('any other gathers its output and draws it together, at most every so often', () => {
  const out: string[] = []
  const pacer = createOutputPacer((d) => out.push(d), () => false, 100)
  pacer.write('a')
  pacer.write('b')
  vi.advanceTimersByTime(99)
  expect(out).toEqual([])
  pacer.write('c')
  vi.advanceTimersByTime(1)
  expect(out).toEqual(['abc'])
  pacer.write('d')
  vi.advanceTimersByTime(100)
  expect(out).toEqual(['abc', 'd'])
})

test('getting focus draws what was held, and what follows comes after it, in order', () => {
  const out: string[] = []
  let focused = false
  const pacer = createOutputPacer((d) => out.push(d), () => focused, 100)
  pacer.write('held ')
  focused = true
  pacer.write('typed')
  expect(out).toEqual(['held ', 'typed'])
  pacer.write('x')
  focused = false
  pacer.write('y')
  pacer.flush()
  expect(out).toEqual(['held ', 'typed', 'x', 'y'])
})

test('a closed window writes nothing more', () => {
  const write = vi.fn()
  const pacer = createOutputPacer(write, () => false, 100)
  pacer.write('a')
  pacer.dispose()
  vi.advanceTimersByTime(500)
  pacer.write('b')
  expect(write).not.toHaveBeenCalled()
})

test('a pace that changes: a sooner one brings the waiting drawing forward, a later one leaves it', () => {
  const out: string[] = []
  let pace = 1000
  const pacer = createOutputPacer((d) => out.push(d), () => false, () => pace)
  pacer.write('a')
  vi.advanceTimersByTime(50)
  pace = 100
  pacer.write('b')
  vi.advanceTimersByTime(100)
  expect(out).toEqual(['ab'])
  pacer.write('c')
  pace = 1000
  pacer.write('d')
  vi.advanceTimersByTime(100)
  expect(out).toEqual(['ab', 'cd'])
})

test('a pace of 0 hands output on at once, after anything held', () => {
  const out: string[] = []
  let pace = 250
  const pacer = createOutputPacer((d) => out.push(d), () => false, () => pace)
  pacer.write('a')
  pace = 0
  pacer.write('b')
  expect(out).toEqual(['a', 'b'])
})
