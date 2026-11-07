import { expect, test, vi } from 'vitest'
import { actionById } from '../../src/renderer/actions'
import type { Commands } from '../../src/renderer/menus'

test('the palette offers both ways out, named for what each does to sessions', () => {
  expect(actionById('quit')?.label).toBe('Quit (sessions keep running)')
  expect(actionById('stop-all-quit')?.label).toBe('Stop all sessions and quit')
})

test('each runs its own command, so neither can stand in for the other', () => {
  const c = { quit: vi.fn(), stopAllAndQuit: vi.fn() } as unknown as Commands
  actionById('quit')?.run(c)
  expect(c.quit).toHaveBeenCalledOnce()
  expect(c.stopAllAndQuit).not.toHaveBeenCalled()
  actionById('stop-all-quit')?.run(c)
  expect(c.stopAllAndQuit).toHaveBeenCalledOnce()
})

test('neither is bound to a key by default, so a slip of the fingers can never end every session', () => {
  expect(actionById('quit')?.key).toBeUndefined()
  expect(actionById('stop-all-quit')?.key).toBeUndefined()
})
