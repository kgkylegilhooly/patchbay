import { expect, test } from 'vitest'
import { createOutputPacer } from '../../src/main/outputPacer'

function setup(opts: { wants?: (w: number, id: string) => boolean; keepChars?: number; foreground?: (id: string) => boolean; hardWater?: number } = {}) {
  const sent: Array<{ id: string; data: string; seq: number }> = []
  const buffers = new Map<string, { data: string; seq: number }>()
  const win = { id: 7, send: (_channel: string, id: unknown, data: unknown, seq: unknown) => void sent.push({ id: id as string, data: data as string, seq: seq as number }) }
  const pacer = createOutputPacer({
    snapshot: (id) => buffers.get(id) ?? { data: '', seq: 0 },
    wants: opts.wants ?? (() => true),
    highWater: 100,
    hardWater: opts.hardWater ?? 100,
    lowWater: 30,
    keepChars: opts.keepChars ?? 50,
    foreground: opts.foreground
  })
  /** Output as the host hands it on: the buffer grows and the count goes up, whether or not the window is sent it. */
  const print = (id: string, data: string): void => {
    const b = buffers.get(id) ?? { data: '', seq: 0 }
    const next = { data: b.data + data, seq: b.seq + 1 }
    buffers.set(id, next)
    pacer.deliver(win, id, data, next.seq)
  }
  const taken = (): number => sent.reduce((n, c) => n + c.data.length, 0)
  return { pacer, win, sent, print, taken }
}

test('a window that keeps up is sent every chunk, in order', () => {
  const t = setup()
  for (let i = 0; i < 20; i++) {
    t.print('a', 'x'.repeat(10))
    t.pacer.ack(t.win, t.taken())
  }
  expect(t.sent).toHaveLength(20)
  expect(t.sent.map((c) => c.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  expect(t.pacer.state(7)).toMatchObject({ unacked: 0, held: false })
})

test('a window that stops taking output is sent no more past the high-water mark, however much comes', () => {
  const t = setup()
  for (let i = 0; i < 1000; i++) t.print(i % 2 ? 'a' : 'b', 'y'.repeat(10))
  // 100 characters of room, so no more than one chunk past it.
  expect(t.taken()).toBeLessThanOrEqual(110)
  expect(t.pacer.state(7)).toMatchObject({ held: true, missed: 2 })
})

test('a short stall: each session gets exactly what it missed, with no reset, so a selection or search survives', () => {
  const t = setup({ keepChars: 1000 })
  for (let i = 0; i < 30; i++) t.print(i % 2 ? 'a' : 'b', String(i).padStart(10, '-'))
  const at = t.sent.length
  for (let i = 0; i < 3; i++) t.pacer.ack(t.win, t.taken())
  const caught = t.sent.slice(at)
  // Together with what was sent before the stall, each session's output is whole, in order, and starts no afresh.
  for (const id of ['a', 'b']) {
    const all = t.sent.filter((c) => c.id === id).map((c) => c.data).join('')
    const expected = Array.from({ length: 30 }, (_, i) => i).filter((i) => (i % 2 ? 'a' : 'b') === id).map((i) => String(i).padStart(10, '-')).join('')
    expect(all).toBe(expected)
  }
  expect(caught.every((c) => !c.data.includes(String.fromCharCode(27) + 'c'))).toBe(true)
  expect(caught.find((c) => c.id === 'a')?.seq).toBe(15)
  expect(t.pacer.state(7)).toMatchObject({ held: false })
})

test('a long stall: a session that missed more than is kept gets its whole buffer from a clean slate, with its latest count', () => {
  const t = setup()
  for (let i = 0; i < 30; i++) t.print(i % 2 ? 'a' : 'b', 'z'.repeat(10))
  const before = t.sent.length
  t.pacer.ack(t.win, t.taken())
  // One buffer of 150 is past the high-water mark of 100, so the other waits for the next ack: one at a time.
  expect(t.sent.length).toBe(before + 1)
  expect(t.pacer.state(7)).toMatchObject({ held: true, missed: 1 })
  t.pacer.ack(t.win, t.taken())
  const resent = t.sent.slice(before)
  expect(resent.map((c) => c.id).sort()).toEqual(['a', 'b'])
  for (const c of resent) {
    expect(c.data.startsWith('\x1bc')).toBe(true)
    expect(c.data.slice(2)).toBe('z'.repeat(150))
    expect(c.seq).toBe(15)
  }
  t.pacer.ack(t.win, t.taken())
  expect(t.pacer.state(7)).toMatchObject({ held: false })
  // And live output flows again after.
  t.print('a', 'live')
  expect(t.sent[t.sent.length - 1]).toMatchObject({ id: 'a', data: 'live', seq: 16 })
})

test('a session the window no longer shows is not caught up', () => {
  let shows = true
  const t = setup({ wants: () => shows })
  for (let i = 0; i < 30; i++) t.print('a', 'w'.repeat(10))
  shows = false
  const before = t.sent.length
  t.pacer.ack(t.win, t.taken())
  expect(t.sent.length).toBe(before)
  expect(t.pacer.state(7)).toMatchObject({ held: false })
})

test('an ack for more than was sent, or an old one, changes nothing; a reloaded window starts afresh', () => {
  const t = setup()
  for (let i = 0; i < 30; i++) t.print('a', 'v'.repeat(10))
  t.pacer.ack(t.win, 1e9)
  // Capped at what was sent: caught up exactly once.
  expect(t.pacer.state(7)?.unacked).toBeGreaterThanOrEqual(0)
  t.pacer.ack(t.win, 5)
  t.pacer.forget(7)
  expect(t.pacer.state(7)).toBeNull()
  t.print('a', 'fresh')
  expect(t.sent[t.sent.length - 1].data).toBe('fresh')
})

test('terminals kept warm out of sight are held first, so they cannot push the ones on screen behind', () => {
  const t = setup({ foreground: (id) => id.startsWith('front'), hardWater: 300, keepChars: 10_000 })
  // A window that has stopped taking output: the background fills the first 100, then only the front gets through.
  for (let i = 0; i < 40; i++) {
    t.print('back' + (i % 3), 'b'.repeat(10))
    t.print('front', 'f'.repeat(5))
  }
  expect(t.pacer.state(7)).toMatchObject({ holding: 'background' })
  const front = t.sent.filter((c) => c.id === 'front')
  expect(front).toHaveLength(40)
  expect(front.map((c) => c.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
  // Background sent only until the high-water mark: far less than the 1,200 characters they printed.
  expect(t.sent.filter((c) => c.id.startsWith('back')).reduce((n, c) => n + c.data.length, 0)).toBeLessThanOrEqual(110)
})

test('the ones on screen are held only past the hard mark, which by then only they can reach', () => {
  const t = setup({ foreground: (id) => id === 'front', hardWater: 300, keepChars: 10_000 })
  for (let i = 0; i < 100; i++) {
    t.print('back', 'b'.repeat(10))
    t.print('front', 'f'.repeat(10))
  }
  expect(t.pacer.state(7)).toMatchObject({ holding: 'all' })
  const sentFront = t.sent.filter((c) => c.id === 'front').reduce((n, c) => n + c.data.length, 0)
  expect(sentFront).toBeGreaterThanOrEqual(190)
  expect(sentFront).toBeLessThanOrEqual(310)
})

test('catching up sends what the screen missed first, and every session ends up whole and exact', () => {
  const t = setup({ foreground: (id) => id === 'front', hardWater: 150, keepChars: 10_000 })
  for (let i = 0; i < 30; i++) {
    t.print('back', String(i).padStart(10, 'b'))
    t.print('front', String(i).padStart(10, 'f'))
  }
  const at = t.sent.length
  for (let i = 0; i < 20 && t.pacer.state(7)?.held; i++) t.pacer.ack(t.win, t.taken())
  const caught = t.sent.slice(at)
  expect(caught[0].id).toBe('front')
  for (const [id, pad] of [['front', 'f'], ['back', 'b']] as const) {
    expect(t.sent.filter((c) => c.id === id).map((c) => c.data).join('')).toBe(Array.from({ length: 30 }, (_, i) => String(i).padStart(10, pad)).join(''))
  }
  expect(caught.every((c) => !c.data.startsWith(String.fromCharCode(27)))).toBe(true)
})

test('a catch-up never starts the same session afresh twice, even while output keeps coming', () => {
  // Sessions kept warm out of sight, held first. A buffer is far smaller than the marks, as 1 MB is beside 4 and 8 MB.
  const t = setup({ keepChars: 5, hardWater: 2000, foreground: () => false })
  for (let i = 0; i < 120; i++) {
    t.print('a', 'x'.repeat(10))
    t.print('b', 'y'.repeat(10))
  }
  // A slow page: it takes what it's given a little at a time, and both sessions keep printing throughout.
  for (let round = 0; round < 40; round++) {
    t.pacer.ack(t.win, t.taken())
    t.print('a', 'x'.repeat(10))
    t.print('b', 'y'.repeat(10))
  }
  for (let i = 0; i < 10; i++) t.pacer.ack(t.win, t.taken())
  const resets = (id: string): number => t.sent.filter((c) => c.id === id && c.data.startsWith(String.fromCharCode(27) + 'c')).length
  expect(resets('a')).toBe(1)
  expect(resets('b')).toBe(1)
  // And each still ends up exactly as its session's buffer.
  for (const id of ['a', 'b']) {
    const chunks = t.sent.filter((c) => c.id === id)
    const last = chunks.map((c) => c.data.startsWith(String.fromCharCode(27) + 'c')).lastIndexOf(true)
    expect(chunks[last].seq).toBeLessThan(chunks[chunks.length - 1].seq)
  }
})
