import { expect, test, vi } from 'vitest'
import { ACTIONS } from '../../src/renderer/actions'
import { canvasMenu, fileMenu, type Commands, type MenuEntry, type MenuItem, type MenuState } from '../../src/renderer/menus'
import { useRecipeUi } from '../../src/renderer/recipeUi'

const commands = new Proxy({} as Commands, { get: () => vi.fn() })
const state: MenuState = { selectedCount: 0, canCopy: false, canFind: false, sidebar: true, minimap: true, legend: false, snap: false, canUndo: false, canRedo: false, hasWindow: false, canName: false, canCloseProject: true }
const find = (menu: MenuEntry[], id: string): MenuItem | undefined => menu.find((e): e is MenuItem => e !== 'separator' && e.id === id)

test('New from recipe is in the canvas menu, the File menu and the palette, and opens the picker where clicked', () => {
  const at = { x: 5, y: 6 }
  find(canvasMenu(commands, state, at), 'new-from-recipe')?.run()
  expect(useRecipeUi.getState()).toEqual({ picker: { at }, saving: false })
  expect(find(fileMenu(commands, state), 'new-from-recipe')).toBeDefined()
  expect(ACTIONS.find((a) => a.id === 'new-from-recipe')?.section).toBe('New')
})

test('Save selection as recipe is offered only with something selected', () => {
  expect(find(canvasMenu(commands, state, { x: 0, y: 0 }), 'save-recipe')).toBeUndefined()
  find(canvasMenu(commands, { ...state, selectedCount: 2 }, { x: 0, y: 0 }), 'save-recipe')?.run()
  expect(useRecipeUi.getState()).toEqual({ picker: null, saving: true })
  const action = ACTIONS.find((a) => a.id === 'save-recipe')!
  expect(action.ready?.(state)).toBe(false)
  expect(action.ready?.({ ...state, selectedCount: 1 })).toBe(true)
})
