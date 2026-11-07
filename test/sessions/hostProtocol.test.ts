import { expect, test } from 'vitest'
import { createFrameReader, encodeFrame, pipeNameFor, proofFor, proofMatches, type HostMessage } from '../../src/main/sessions/hostProtocol'

function collect(limit = 1024 * 1024): { frames: HostMessage[]; errors: string[]; reader: ReturnType<typeof createFrameReader> } {
  const frames: HostMessage[] = []
  const errors: string[] = []
  const reader = createFrameReader({ limit, onFrame: (m) => frames.push(m), onError: (e) => errors.push(e) })
  return { frames, errors, reader }
}

test('a frame split at every possible byte still arrives whole, once', () => {
  const message: HostMessage = { t: 'o', id: 'a', d: 'héllo \x1b[31mwörld\x1b[0m 日本語 🎉' }
  const bytes = encodeFrame(message)
  for (let cut = 1; cut < bytes.length; cut++) {
    const { frames, reader } = collect()
    reader.push(bytes.subarray(0, cut))
    reader.push(bytes.subarray(cut))
    expect(frames).toEqual([message])
  }
})

test('frames sharing one chunk arrive in order', () => {
  const { frames, reader } = collect()
  const all: HostMessage[] = [1, 2, 3].map((n) => ({ t: 'o', id: 'a', d: String(n) }))
  reader.push(Buffer.concat(all.map(encodeFrame)))
  expect(frames).toEqual(all)
})

test('a frame over the limit is refused before it is buffered, and nothing follows it', () => {
  const { frames, errors, reader } = collect(16)
  const big = encodeFrame({ t: 'o', id: 'a', d: 'x'.repeat(100) })
  reader.push(big.subarray(0, 4))
  expect(errors).toHaveLength(1)
  reader.push(big.subarray(4))
  reader.push(encodeFrame({ t: 'x', id: 'a', code: 0 }))
  expect(frames).toEqual([])
  expect(errors).toHaveLength(1)
})

test('a frame that is not JSON ends the stream', () => {
  const { errors, reader } = collect()
  const body = Buffer.from('{nope')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  reader.push(Buffer.concat([head, body]))
  expect(errors).toHaveLength(1)
})

test('the limit can rise once a connection has proved itself', () => {
  const { frames, errors, reader } = collect(8)
  reader.setLimit(1024)
  reader.push(encodeFrame({ t: 'o', id: 'a', d: 'x'.repeat(100) }))
  expect(errors).toEqual([])
  expect(frames).toHaveLength(1)
})

test('each profile gets its own pipe, and spelling a path differently does not change it', () => {
  expect(pipeNameFor('C:\\a\\one')).not.toBe(pipeNameFor('C:\\a\\two'))
  expect(pipeNameFor('C:\\A\\One')).toBe(pipeNameFor('c:\\a\\one\\'))
  expect(pipeNameFor('C:\\a\\one')).toMatch(/^\\\\\.\\pipe\\patchbay-host-[0-9a-f]+$/)
})

test('a proof is bound to the secret, the role and the nonce', () => {
  const proof = proofFor('s', 'app', 'n')
  expect(proofMatches(proof, proofFor('s', 'app', 'n'))).toBe(true)
  expect(proofMatches(proof, proofFor('other', 'app', 'n'))).toBe(false)
  expect(proofMatches(proof, proofFor('s', 'host', 'n'))).toBe(false)
  expect(proofMatches(proof, proofFor('s', 'app', 'other'))).toBe(false)
  expect(proofMatches(undefined, proof)).toBe(false)
  expect(proofMatches('short', proof)).toBe(false)
})
