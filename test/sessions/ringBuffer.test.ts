import { expect, test } from 'vitest'
import { createRingBuffer } from '../../src/main/sessions/ringBuffer'

test('ring buffer drops oldest bytes past the cap', () => {
  const ring = createRingBuffer(5)
  ring.append('abc')
  ring.append('defg')
  expect(ring.read()).toBe('cdefg')
})

test('a single chunk larger than the cap keeps only its tail', () => {
  const ring = createRingBuffer(3)
  ring.append('abcdefgh')
  expect(ring.read()).toBe('fgh')
})

test('the cap counts bytes and a multi-byte character is never split', () => {
  const ring = createRingBuffer(4)
  ring.append('é€') // 2 + 3 bytes
  expect(ring.read()).toBe('€')
  ring.append('😀') // 4 bytes
  expect(ring.read()).toBe('😀')
})

test('a seeded buffer is capped like any other content', () => {
  const ring = createRingBuffer(2, 'xyz')
  expect(ring.read()).toBe('yz')
})
