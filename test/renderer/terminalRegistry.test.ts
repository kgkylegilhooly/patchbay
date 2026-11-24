import { afterEach, expect, test, vi } from 'vitest'
import { cancelPendingFocus, focusTerminalWhenReady, onFocusWanted, PENDING_FOCUS_MS, registerTerminal } from '../../src/renderer/terminalRegistry'

const actions = () => ({ hasSelection: () => false, selection: () => '', copy: vi.fn(), paste: vi.fn(), find: vi.fn(), focus: vi.fn() })
afterEach(() => cancelPendingFocus())

test('a terminal already built takes the keyboard at once', () => {
  const a = actions()
  const off = registerTerminal('built', a)
  focusTerminalWhenReady('built')
  expect(a.focus).toHaveBeenCalledTimes(1)
  off()
})

test('a terminal not built yet takes the keyboard when it registers, and its build is asked to go first', () => {
  const wanted = vi.fn()
  onFocusWanted(wanted)
  focusTerminalWhenReady('cold')
  expect(wanted).toHaveBeenCalledWith('cold')
  const a = actions()
  const off = registerTerminal('cold', a)
  expect(a.focus).toHaveBeenCalledTimes(1)
  off()
  // Taken once: drawn again later, it doesn't grab the keyboard.
  const again = actions()
  registerTerminal('cold', again)()
  expect(again.focus).not.toHaveBeenCalled()
})

test('only the latest ask waits, and an old one lapses', () => {
  focusTerminalWhenReady('first')
  focusTerminalWhenReady('second')
  const first = actions()
  registerTerminal('first', first)()
  expect(first.focus).not.toHaveBeenCalled()

  focusTerminalWhenReady('late', Date.now() - PENDING_FOCUS_MS - 1)
  const late = actions()
  registerTerminal('late', late)()
  expect(late.focus).not.toHaveBeenCalled()
})
