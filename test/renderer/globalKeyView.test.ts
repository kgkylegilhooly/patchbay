import { expect, test } from 'vitest'
import { recordedKey } from '../../src/renderer/globalKeyView'

const press = (over: Partial<Parameters<typeof recordedKey>[0]>) => recordedKey({ key: 'j', code: 'KeyJ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over })

test('the keys pressed are named as Electron takes them, by where they are on the keyboard', () => {
  expect(press({ ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+J')
  expect(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+1')
  expect(press({ key: 'F12', code: 'F12', metaKey: true })).toBe('Super+F12')
  // A modifier on its own, or Tab, isn't a key yet: nothing is recorded.
  expect(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBeNull()
  expect(press({ key: 'Tab', code: 'Tab' })).toBeNull()
})
