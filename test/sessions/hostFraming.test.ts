import { expect, test } from 'vitest'
import { createFrameReader, encodeFrame, type HostMessage } from '../../src/main/sessions/hostProtocol'

const frames = (n: number, size: number): Buffer[] => Array.from({ length: n }, (_, i) => encodeFrame({ t: 'o', id: `s${i}`, d: `${i}:`.padEnd(size, 'é') }))

function readAll(stream: Buffer, cut: (at: number) => number, limit = 32 * 1024 * 1024): { got: HostMessage[]; errors: string[] } {
  const got: HostMessage[] = []
  const errors: string[] = []
  const reader = createFrameReader({ limit, onFrame: (m) => got.push(m), onError: (e) => errors.push(e) })
  for (let at = 0; at < stream.length; ) {
    const next = Math.min(stream.length, at + Math.max(1, cut(at)))
    reader.push(stream.subarray(at, next))
    at = next
  }
  return { got, errors }
}

test('frames come out whole and in order however the stream is cut, down to single bytes', () => {
  const all = frames(12, 3000)
  const stream = Buffer.concat(all)
  const expected = all.map((f) => JSON.parse(f.subarray(4).toString('utf8')))
  let seed = 7
  const random = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed)
  for (const cut of [() => stream.length, () => 1, () => 3, () => 4096, () => 1 + (random() % 9000)]) {
    const { got, errors } = readAll(stream, cut)
    expect(errors).toEqual([])
    expect(got).toEqual(expected)
  }
})

test('a header split across pieces is still read, and a frame over the limit is refused once', () => {
  const big = encodeFrame({ t: 'o', id: 'x', d: 'a'.repeat(5000) })
  const { got, errors } = readAll(big, () => 2, 1000)
  expect(got).toEqual([])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/over the limit/)
})

test('a frame that is not JSON is refused, and nothing after it is read', () => {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(3, 0)
  const stream = Buffer.concat([header, Buffer.from('{{{'), ...frames(1, 10)])
  const { got, errors } = readAll(stream, () => 5)
  expect(got).toEqual([])
  expect(errors).toEqual(['A frame was not valid JSON.'])
})

test('a big frame in small pieces costs about the same as the frame whole', () => {
  const big = frames(1, 1024 * 1024)[0]
  const time = (chunk: number): number => {
    const started = performance.now()
    for (let n = 0; n < 5; n++) readAll(big, () => chunk)
    return performance.now() - started
  }
  time(big.length)
  const whole = time(big.length)
  const pieces = time(4096)
  // Joining each piece onto everything before it was quadratic: 40x slower in 4 KB pieces.
  expect(pieces).toBeLessThan(whole * 8 + 50)
})
