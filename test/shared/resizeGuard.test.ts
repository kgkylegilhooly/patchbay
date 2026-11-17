import { expect, test } from 'vitest'
import { atShellPrompt, guardFirstKey, isFocusReport, SACRIFICE } from '../../src/shared/resizeGuard'

const prompt = { bracketedPaste: true, alternateScreen: false, beforeCursor: '$ ' }

test('the first key after a resize at a bash prompt gets the sacrifice ahead of it', () => {
  expect(guardFirstKey('e', true, prompt)).toBe(SACRIFICE + 'e')
  expect(guardFirstKey('e', true, { ...prompt, beforeCursor: 'root@box:~# ' })).toBe(SACRIFICE + 'e')
})

test('nothing is added without a resize, or anywhere but an empty bash prompt', () => {
  expect(guardFirstKey('e', false, prompt)).toBe('e')
  // A program asking a question, a password prompt, or a command running: no bracketed paste.
  expect(guardFirstKey('y', true, { ...prompt, bracketedPaste: false, beforeCursor: 'Continue? [y/N] ' })).toBe('y')
  expect(guardFirstKey('p', true, { ...prompt, bracketedPaste: false, beforeCursor: 'Password: ' })).toBe('p')
  // A full-screen program, and prompts that aren't bash's, such as PowerShell, cmd, Python and Claude.
  expect(guardFirstKey('j', true, { ...prompt, alternateScreen: true })).toBe('j')
  for (const before of ['PS C:\Code> ', 'C:\Code>', '>>> ', '> ']) expect(guardFirstKey('x', true, { ...prompt, beforeCursor: before })).toBe('x')
  // Partway through typing a command.
  expect(atShellPrompt({ ...prompt, beforeCursor: '$ git sta' })).toBe(false)
})

test('focus reports are told apart from keys, so they never take the guard meant for the first key', () => {
  expect(isFocusReport('\x1b[I')).toBe(true)
  expect(isFocusReport('\x1b[O\x1b[I')).toBe(true)
  for (const key of ['e', '\x1b', '\x1b[A', '\x1b[Ie', '\r']) expect(isFocusReport(key)).toBe(false)
})
