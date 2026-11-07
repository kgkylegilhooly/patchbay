import { expect, test } from 'vitest'
import { ACTIONS, actionById, actionReady, worksOverBoard } from '../../src/renderer/actions'
import type { MenuState } from '../../src/renderer/menus'

const state = (board: boolean): MenuState => ({
  selectedCount: 1, canCopy: true, canFind: true, sidebar: true, minimap: true, legend: false, snap: false,
  canUndo: true, canRedo: true, hasWindow: true, canName: true, canCloseProject: true, board
})

test('with the board open, nothing aimed at the hidden canvas can run', () => {
  for (const id of ['select-all', 'group', 'undo', 'tidy', 'zoom-in', 'fit-view', 'focus-left', 'new-terminal', 'new-sticky', 'refresh-window', 'toggle-maximize', 'font-larger', 'toggle-minimap']) {
    const a = actionById(id)!
    expect(actionReady(a, state(true)), id).toBe(false)
    expect(actionReady(a, state(false)), id).toBe(true)
  }
})

test('the palette, settings, the board and git panel toggles, and quitting still work over the board', () => {
  for (const id of ['open-palette', 'open-settings', 'toggle-board', 'toggle-git', 'quit', 'stop-all-quit', 'close-project']) {
    expect(actionReady(actionById(id)!, state(true)), id).toBe(true)
  }
  // Every action is one or the other, and the App section is always allowed.
  expect(ACTIONS.filter((a) => a.section === 'App').every(worksOverBoard)).toBe(true)
})
