import { beforeEach, describe, expect, test, vi } from 'vitest'
import { addMenu, canvasMenu, fileMenu, type Commands, type MenuEntry, type MenuItem, type MenuState } from '../../src/renderer/menus'
import { drillEntries, firstUsable, MENU_BACK } from '../../src/renderer/menuDrill'
import { pathMenu } from '../../src/renderer/pathMenu'
import { setTerminalProfiles } from '../../src/renderer/terminalProfilesUi'

const commands = new Proxy({} as Commands, { get: () => vi.fn() })
const state: MenuState = { selectedCount: 0, canCopy: false, canFind: false, sidebar: true, minimap: true, legend: false, snap: false, canUndo: false, canRedo: false, hasWindow: false, canName: false, canCloseProject: true }
const ids = (menu: MenuEntry[]): string[] => menu.filter((e): e is MenuItem => e !== 'separator').map((i) => i.id)
const profile = (id: string, name: string) => ({ id, name, program: 'cmd.exe', args: [] })

describe('New menus (audit #4)', () => {
  beforeEach(() => setTerminalProfiles({ profiles: [profile('builtin:pwsh', 'PowerShell')] } as never))

  test('start an agent first, then a terminal, in the canvas, File and add menus', () => {
    for (const menu of [canvasMenu(commands, state, { x: 0, y: 0 }), addMenu(commands)]) expect(ids(menu).slice(0, 3)).toEqual(['new-claude', 'new-codex', 'new-terminal'])
    const file = ids(fileMenu(commands, state))
    expect(file.indexOf('new-claude')).toBeLessThan(file.indexOf('new-terminal'))
  })

  test('other profiles sit in one "New terminal with" row, so the menu is as long with five profiles as with one', () => {
    const short = ids(canvasMenu(commands, state, { x: 0, y: 0 })).length
    setTerminalProfiles({ profiles: ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => profile(`custom:${p}`, p.toUpperCase())) } as never)
    const menu = canvasMenu(commands, state, { x: 0, y: 0 })
    expect(ids(menu).length).toBe(short + 1)
    const row = menu.find((e): e is MenuItem => e !== 'separator' && e.id === 'new-terminal-with')!
    expect(ids(menu).indexOf('new-terminal-with')).toBe(ids(menu).indexOf('new-terminal') + 1)
    expect(row.submenu!.map((e) => (e as MenuItem).label)).toEqual(['B', 'C', 'D', 'E', 'F'])
  })

  test('a profile in the submenu opens a terminal of that profile where the menu was opened', () => {
    setTerminalProfiles({ profiles: [profile('builtin:pwsh', 'PowerShell'), profile('custom:vs', 'VS prompt')] } as never)
    const newTerminal = vi.fn()
    const at = { x: 4, y: 5 }
    const row = canvasMenu({ ...commands, newTerminal } as Commands, state, at).find((e): e is MenuItem => e !== 'separator' && e.id === 'new-terminal-with')!
    ;(row.submenu![0] as MenuItem).run()
    expect(newTerminal).toHaveBeenCalledWith(at, undefined, 'custom:vs')
  })

  test('the path menu does the same: one row with the profiles under it', () => {
    const act = { open: vi.fn(), newTerminal: vi.fn(), copy: vi.fn(), reveal: vi.fn(), profiles: [{ id: 'custom:vs', name: 'VS prompt' }, { id: 'builtin:wsl', name: 'WSL' }] }
    const menu = pathMenu(act)
    expect(ids(menu)).toEqual(['path-open', 'path-new-terminal', 'path-new-terminal-with', 'path-copy', 'path-reveal'])
    const row = menu.find((e): e is MenuItem => e !== 'separator' && e.id === 'path-new-terminal-with')!
    for (const p of row.submenu!) (p as MenuItem).run()
    expect(act.newTerminal.mock.calls).toEqual([['custom:vs'], ['builtin:wsl']])
    expect(ids(pathMenu({ ...act, profiles: [] }))).not.toContain('path-new-terminal-with')
  })
})

describe('a submenu opened in the menu', () => {
  const sub: MenuItem = { id: 'more', label: 'New terminal with', run: () => {}, submenu: [{ id: 'x', label: 'X', run: () => {}, disabled: true }, { id: 'y', label: 'Y', run: () => {} }] }
  const menu: MenuEntry[] = [{ id: 'a', label: 'A', run: () => {} }, sub]

  test('shows its rows under a row back that names it, in place of the menu', () => {
    expect(drillEntries(menu, null, () => {})).toBe(menu)
    const shown = drillEntries(menu, sub, () => {})
    expect(shown[0]).toMatchObject({ id: MENU_BACK, label: 'New terminal with', icon: 'arrow-left' })
    expect(ids(shown)).toEqual([MENU_BACK, 'x', 'y'])
  })

  test('marks the first row that can be used', () => {
    expect(firstUsable(drillEntries(menu, sub, () => {}))).toBe('y')
  })
})
