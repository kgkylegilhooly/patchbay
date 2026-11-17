import { expect, test } from 'vitest'
import { createSendGuard, isGitBashFile } from '../../src/main/sessions/sendGuard'
import { SACRIFICE } from '../../src/shared/resizeGuard'

const atPrompt = '\x1b[?2004h\x1b[32mme@pc\x1b[m\r\n$ '
const running = '\x1b[?2004l\r\n'

test('text typed into Git Bash after a resize, at its prompt, gets the byte ahead of it once', () => {
  const g = createSendGuard({ isGitBash: () => true })
  g.output('t', atPrompt)
  g.resized('t')
  expect(g.prefixFor('t')).toBe(SACRIFICE)
  expect(g.prefixFor('t')).toBe('')
})

test('nothing is added without a resize, while a command runs, or for a shell that is not Git Bash', () => {
  const g = createSendGuard({ isGitBash: (id) => id !== 'pwsh' })
  g.output('t', atPrompt)
  expect(g.prefixFor('t')).toBe('')
  g.output('busy', atPrompt + 'npm test' + running)
  g.resized('busy')
  expect(g.prefixFor('busy')).toBe('')
  g.output('pwsh', atPrompt)
  g.resized('pwsh')
  expect(g.prefixFor('pwsh')).toBe('')
  // Nothing has been seen yet: bracketed paste isn't known to be on.
  g.resized('fresh')
  expect(g.prefixFor('fresh')).toBe('')
})

test('a key typed in the window since the resize means bash has read, so no byte; focus reports do not count', () => {
  const g = createSendGuard({ isGitBash: () => true })
  g.output('t', atPrompt)
  g.resized('t')
  g.typed('t', '\x1b[I')
  expect(g.prefixFor('t')).toBe(SACRIFICE)
  g.resized('t')
  g.typed('t', 'l')
  expect(g.prefixFor('t')).toBe('')
})

test('forgetting a closed terminal drops what was known about it', () => {
  const g = createSendGuard({ isGitBash: () => true })
  g.output('t', atPrompt)
  g.resized('t')
  g.forget('t')
  g.resized('t')
  expect(g.prefixFor('t')).toBe('')
})

test('only Git for Windows bash counts, not WSL or other shells', () => {
  expect(isGitBashFile(String.raw`C:\Program Files\Git\bin\bash.exe`)).toBe(true)
  expect(isGitBashFile('C:/msys64/usr/bin/bash.exe')).toBe(true)
  expect(isGitBashFile(String.raw`C:\Windows\System32\bash.exe`)).toBe(false)
  expect(isGitBashFile(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`)).toBe(false)
  expect(isGitBashFile('cmd.exe')).toBe(false)
})
