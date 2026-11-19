import { describe, expect, test, vi } from 'vitest'
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

test("says whether a session last turned bracketed paste on or off, and nothing for one it hasn't seen", () => {
  const g = createSendGuard({ isGitBash: () => false })
  expect(g.pasteOn('a')).toBeUndefined()
  g.output('a', '\x1b[?2004h')
  expect(g.pasteOn('a')).toBe(true)
  g.output('a', 'editor opens\x1b[?2004l')
  expect(g.pasteOn('a')).toBe(false)
  g.forget('a')
  expect(g.pasteOn('a')).toBeUndefined()
})

describe('what the person is typing at an agent', () => {
  const make = () => {
    const settled: string[] = []
    const g = createSendGuard({ isGitBash: () => false, draftQuietMs: 20_000, afterEnterMs: 3000 })
    g.onDraftSettled((id) => settled.push(id))
    return { g, settled }
  }

  test('holds while they type, until 20 s pass with nothing more', () => {
    vi.useFakeTimers()
    const { g, settled } = make()
    expect(g.drafting('a')).toBe(false)
    g.typed('a', '!git sta')
    expect(g.drafting('a')).toBe(true)
    vi.advanceTimersByTime(15_000)
    g.typed('a', 't')
    vi.advanceTimersByTime(15_000)
    expect(g.drafting('a')).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(g.drafting('a')).toBe(false)
    expect(settled).toEqual(['a'])
    vi.useRealTimers()
  })

  test('Enter or Ctrl+C ends it after a short wait, for the agent to show it took what they sent', () => {
    vi.useFakeTimers()
    const { g, settled } = make()
    g.typed('a', 'hello')
    g.typed('a', '\r')
    expect(g.drafting('a')).toBe(true)
    vi.advanceTimersByTime(3000)
    expect(g.drafting('a')).toBe(false)
    g.typed('b', 'oops')
    g.typed('b', '\x03')
    vi.advanceTimersByTime(3000)
    expect(settled).toEqual(['a', 'b'])
    // Text after the Enter is a new draft.
    g.typed('c', 'one\rtwo')
    vi.advanceTimersByTime(3000)
    expect(g.drafting('c')).toBe(true)
    vi.useRealTimers()
  })

  test("the terminal's own replies, focus changes and mouse reports are not typing", () => {
    const { g } = make()
    for (const data of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b]11;rgb:0000/0000/0000\x07'])
      g.typed('a', data)
    expect(g.drafting('a')).toBe(false)
    g.typed('a', '\x1b[A') // Up recalls an earlier prompt into the box.
    expect(g.drafting('a')).toBe(true)
  })

  test('forget drops it without a settle', () => {
    vi.useFakeTimers()
    const { g, settled } = make()
    g.typed('a', 'x')
    g.forget('a')
    vi.advanceTimersByTime(60_000)
    expect(g.drafting('a')).toBe(false)
    expect(settled).toEqual([])
    vi.useRealTimers()
  })
})
