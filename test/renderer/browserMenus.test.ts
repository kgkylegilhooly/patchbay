import { expect, test, vi } from 'vitest'
import { actionById } from '../../src/renderer/actions'
import { canvasMenu, fileMenu, nodeMenu, type Commands, type MenuEntry, type MenuItem, type MenuState } from '../../src/renderer/menus'
import { newBrowser } from '../../src/renderer/newNodes'
import type { BrowserNode, CanvasDoc } from '../../src/shared/model'

const state: MenuState = { selectedCount: 0, canCopy: false, canFind: false, sidebar: true, minimap: true, legend: false, snap: false, canUndo: false, canRedo: false, hasWindow: false, canName: false, canCloseProject: true }
const find = (menu: MenuEntry[], id: string): MenuItem | undefined => menu.find((e): e is MenuItem => e !== 'separator' && e.id === id)
const spy = () => {
  const calls: Array<[string, unknown[]]> = []
  const commands = new Proxy({} as Commands, { get: (_t, key) => vi.fn((...args: unknown[]) => calls.push([String(key), args])) })
  return { commands, calls }
}

test('a browser can be added from the canvas menu, the File menu and the palette, with an icon', () => {
  const { commands, calls } = spy()
  const fromCanvas = find(canvasMenu(commands, state, { x: 3, y: 4 }), 'new-browser')
  expect(fromCanvas?.icon).toBe('browser')
  fromCanvas?.run()
  expect(calls).toEqual([['newBrowser', [{ x: 3, y: 4 }]]])
  expect(find(fileMenu(commands, state), 'new-browser')?.icon).toBe('browser')
  expect(actionById('new-browser')?.icon).toBe('browser')
})

test("a browser node's menu takes control, or hands it back", () => {
  const { commands, calls } = spy()
  const doc = { nodes: [] } as unknown as CanvasDoc
  const node = newBrowser({ at: { x: 0, y: 0 }, group: null, doc }, 'b1')
  expect(node).toMatchObject({ kind: 'browser', url: 'about:blank' })
  const ctx = { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }
  find(nodeMenu(commands, node, null, ctx), 'browser-take-control')?.run()
  const held: BrowserNode = { ...node, held: true }
  expect(find(nodeMenu(commands, held, null, ctx), 'browser-take-control')).toBeUndefined()
  find(nodeMenu(commands, held, null, ctx), 'browser-hand-back')?.run()
  expect(calls).toEqual([
    ['setBrowserHeld', ['b1', true]],
    ['setBrowserHeld', ['b1', false]]
  ])
})
