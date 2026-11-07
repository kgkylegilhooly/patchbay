import { expect, test } from 'vitest'
import { cleanTerminalLook, DEFAULT_FONT_FAMILY, fontStack, SCROLLBACK, TERMINAL_DEFAULTS } from '../../src/renderer/prefs'

test('a missing or broken terminal look means the defaults', () => {
  expect(cleanTerminalLook(undefined)).toEqual(TERMINAL_DEFAULTS)
  expect(cleanTerminalLook('nonsense')).toEqual(TERMINAL_DEFAULTS)
  expect(cleanTerminalLook({ cursorStyle: 'triangle', cursorBlink: 'yes', copyOnSelect: 1, scrollback: 'lots' })).toEqual(TERMINAL_DEFAULTS)
})

test('good values are kept, and scrollback stays within its range', () => {
  expect(cleanTerminalLook({ fontFamily: 'Fira Code', cursorStyle: 'bar', cursorBlink: true, copyOnSelect: true, scrollback: 25_000.4 })).toEqual({
    fontFamily: 'Fira Code',
    cursorStyle: 'bar',
    cursorBlink: true,
    copyOnSelect: true,
    scrollback: 25_000
  })
  expect(cleanTerminalLook({ scrollback: 5 }).scrollback).toBe(SCROLLBACK.min)
  expect(cleanTerminalLook({ scrollback: 9e9 }).scrollback).toBe(SCROLLBACK.max)
})

test('a chosen font goes first with the default after it, and nothing in it can break out of the quotes', () => {
  expect(fontStack('')).toBe(DEFAULT_FONT_FAMILY)
  expect(fontStack('  JetBrains Mono ')).toBe(`"JetBrains Mono", ${DEFAULT_FONT_FAMILY}`)
  expect(fontStack('Evil"; color: red; \\')).toBe(`"Evil color: red ", ${DEFAULT_FONT_FAMILY}`)
})
