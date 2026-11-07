import { expect, test } from 'vitest'
import { createModeTracker, createSessionBuffer, stripTerminalQueries } from '../../src/main/sessions/sessionBuffer'

test('until it wraps, a buffer reads back exactly what went in', () => {
  const buffer = createSessionBuffer(1024)
  const text = 'prompt$ \x1b[?2004h\x1b[31mred\x1b[0m\r\n'
  buffer.append(text)
  expect(buffer.read()).toBe(text)
})

test('modes set before the buffer wrapped are restored at the start of what it reads', () => {
  const buffer = createSessionBuffer(64)
  buffer.append('\x1b[?2004h\x1b[?1049h\x1b[?1000h')
  buffer.append(`${'x'.repeat(100)}\n${'y'.repeat(40)}`)
  const read = buffer.read()
  expect(read.startsWith('\x1b[?1000h\x1b[?1049h\x1b[?2004h')).toBe(true)
  expect(read.endsWith('y'.repeat(40))).toBe(true)
})

test('a wrapped read, modes and all, never goes over the cap, so a tail-keeping store keeps the modes', () => {
  // ConPTY opens every session with modes like these, so a wrapped read always has some to restore.
  for (let cap = 16; cap <= 96; cap += 8) {
    const buffer = createSessionBuffer(cap, '\x1b[?9001h\x1b[?1004h\x1b[?2004h')
    buffer.append(`${'line of output\r\n'.repeat(40)}end`)
    const read = buffer.read()
    expect(Buffer.byteLength(read)).toBeLessThanOrEqual(cap)
    expect(read.startsWith('\x1b[?1004h\x1b[?2004h')).toBe(true)
  }
})

test('a mode turned off again is not restored', () => {
  const buffer = createSessionBuffer(16)
  buffer.append('\x1b[?2004h\x1b[?1049h')
  buffer.append('\x1b[?2004l')
  buffer.append('z'.repeat(40))
  expect(buffer.read()).toContain('\x1b[?1049h')
  expect(buffer.read()).not.toContain('2004')
})

test('a wrapped read skips a partial escape sequence at its start', () => {
  const buffer = createSessionBuffer(12)
  buffer.append('\x1b[38;5;196mABCDEF\x1b[0m')
  expect(buffer.read().startsWith('\x1b[0m')).toBe(true)
})

test('a seed counts, for its modes as well as its text', () => {
  const buffer = createSessionBuffer(8, '\x1b[?2004hbefore')
  buffer.append('0123456789')
  expect(buffer.read()).toContain('\x1b[?2004h')
})

test('the tracker sees a mode sequence cut across two chunks', () => {
  for (const [a, b] of [['\x1b', '[?1049h'], ['\x1b[', '?1049h'], ['\x1b[?', '1049h'], ['\x1b[?10', '49h'], ['\x1b[?1049', 'h']]) {
    const modes = createModeTracker()
    modes.feed(`text${a}`)
    modes.feed(b)
    expect(modes.altScreen()).toBe(true)
    expect(modes.replay()).toBe('\x1b[?1049h')
  }
})

test('the tracker reads several modes in one sequence, and ignores modes it does not track', () => {
  const modes = createModeTracker()
  modes.feed('\x1b[?1000;1006;9001h')
  expect(modes.replay()).toBe('\x1b[?1000h\x1b[?1006h')
})

test('a hidden cursor is replayed, because being on is the default for it', () => {
  const modes = createModeTracker()
  modes.feed('\x1b[?25l')
  expect(modes.replay()).toBe('\x1b[?25l')
  modes.feed('\x1b[?25h')
  expect(modes.replay()).toBe('')
})

test('the alternate screen is tracked in and out', () => {
  const modes = createModeTracker()
  expect(modes.altScreen()).toBe(false)
  modes.feed('\x1b[?1049h')
  expect(modes.altScreen()).toBe(true)
  modes.feed('\x1b[?1049l')
  expect(modes.altScreen()).toBe(false)
})

test.each([
  ['device attributes', '\x1b[c'],
  ['device attributes with a parameter', '\x1b[0c'],
  ['secondary device attributes', '\x1b[>c'],
  ['tertiary device attributes', '\x1b[=c'],
  ['cursor position report', '\x1b[6n'],
  ['status report', '\x1b[5n'],
  ['private cursor report', '\x1b[?6n'],
  ['mode request', '\x1b[?2004$p'],
  ['terminal version', '\x1b[>0q'],
  ['foreground color query, BEL', '\x1b]10;?\x07'],
  ['background color query, ST', '\x1b]11;?\x1b\\'],
  ['palette query', '\x1b]4;1;?\x07'],
  ['setting request', '\x1bP$qm\x1b\\'],
  ['capability request', '\x1bP+q544e\x1b\\']
])('a replay drops a query a terminal would answer as typed text: %s', (_name, query) => {
  expect(stripTerminalQueries(`before${query}after`)).toBe('beforeafter')
})

test.each([
  ['color', '\x1b[31m'],
  ['cursor movement', '\x1b[2;3H'],
  ['erase', '\x1b[2J'],
  ['mode set', '\x1b[?2004h'],
  ['window title', '\x1b]0;my title\x07'],
  ['setting a color', '\x1b]10;#ffffff\x07'],
  ['plain text with a c and an n', 'can nc']
])('a replay keeps what is not a query: %s', (_name, text) => {
  expect(stripTerminalQueries(text)).toBe(text)
})

test('reading strips queries from what gets replayed', () => {
  const buffer = createSessionBuffer(1024)
  buffer.append('a\x1b[6nb')
  expect(buffer.read()).toBe('ab')
})
