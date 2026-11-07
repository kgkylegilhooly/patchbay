import { expect, test } from 'vitest'
import { createAttachGate } from '../../src/renderer/attachGate'

function setup(): { gate: ReturnType<typeof createAttachGate>; out: string[] } {
  const out: string[] = []
  return { gate: createAttachGate((d) => out.push(d)), out }
}

test('replays the snapshot and ignores chunks at or below its seq', () => {
  const { gate, out } = setup()
  gate.snapshot({ data: 'abc', seq: 3 })
  gate.chunk('c', 3)
  gate.chunk('d', 4)
  expect(out).toEqual(['abc', 'd'])
})

test('chunks that arrive before the snapshot are held, then filtered', () => {
  const { gate, out } = setup()
  gate.chunk('b', 2)
  gate.chunk('c', 3)
  gate.snapshot({ data: 'ab', seq: 2 })
  expect(out).toEqual(['ab', 'c'])
})

test('an empty snapshot writes nothing', () => {
  const { gate, out } = setup()
  gate.snapshot({ data: '', seq: 0 })
  gate.chunk('x', 1)
  expect(out).toEqual(['x'])
})
