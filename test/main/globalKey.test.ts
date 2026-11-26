import { expect, test, vi } from 'vitest'
import { createGlobalKey } from '../../src/main/globalKey'

function fake(taken: string[] = []) {
  const held = new Map<string, () => void>()
  return {
    held,
    register: vi.fn((accel: string, cb: () => void) => {
      if (taken.includes(accel)) return false
      held.set(accel, cb)
      return true
    }),
    unregister: vi.fn((accel: string) => void held.delete(accel))
  }
}

// F62: a key that works from any program, to come back to the next agent needing you.
test('off by default; once set, the key brings Patchbay to the next agent needing you', () => {
  const shortcut = fake()
  const pressed = vi.fn()
  const key = createGlobalKey({ ...shortcut, onPress: pressed })
  expect(key.apply(undefined)).toEqual({ key: null, ok: true })
  expect(shortcut.register).not.toHaveBeenCalled()
  expect(key.apply('Ctrl+Alt+J')).toEqual({ key: 'Ctrl+Alt+J', ok: true })
  shortcut.held.get('Ctrl+Alt+J')?.()
  expect(pressed).toHaveBeenCalledOnce()
})

test('changing it lets go of the old key, and turning it off lets go of it altogether', () => {
  const shortcut = fake()
  const key = createGlobalKey({ ...shortcut, onPress: () => {} })
  key.apply('Ctrl+Alt+J')
  key.apply('Ctrl+Shift+F12')
  expect([...shortcut.held.keys()]).toEqual(['Ctrl+Shift+F12'])
  // Saving other settings applies the same key again: nothing is let go or taken twice.
  key.apply('Ctrl+Shift+F12')
  expect(shortcut.register).toHaveBeenCalledTimes(2)
  key.apply('')
  expect([...shortcut.held.keys()]).toEqual([])
})

test("a key another program holds, or one with no Ctrl, Alt or Win, is refused with the reason", () => {
  const shortcut = fake(['Ctrl+Alt+J'])
  const key = createGlobalKey({ ...shortcut, onPress: () => {} })
  expect(key.apply('Ctrl+Alt+J')).toMatchObject({ key: 'Ctrl+Alt+J', ok: false, reason: expect.stringMatching(/another program/i) })
  // Typing a letter anywhere on the PC must never be taken.
  expect(key.apply('J')).toMatchObject({ ok: false, reason: expect.stringMatching(/Ctrl, Alt or Win/) })
  expect(key.apply('Shift+J')).toMatchObject({ ok: false })
  expect(key.apply('Ctrl+Alt+')).toMatchObject({ ok: false })
  expect(key.apply('Ctrl+Alt+JShift+J')).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't one key/) })
  expect(shortcut.held.size).toBe(0)
  expect(key.state()).toMatchObject({ ok: false })
})
