import { describe, expect, test, vi } from 'vitest'
import type { MenuEntry, MenuItem } from '../../src/renderer/menus'
import { placeLabel } from '../../src/renderer/placeLabel'
import { boardColumnMenu } from '../../src/renderer/boardColumnMenu'
import { outcomeSummary } from '../../src/renderer/tasks/outcomeSummary'
import { evidenceTaskLabel, isOpaqueId } from '../../src/renderer/idWords'
import { shelfRowMenu } from '../../src/renderer/shelfRowMenu'
import { minimapItems } from '../../src/renderer/minimapItem'
import { updateCheckRow } from '../../src/renderer/updateCheckRow'
import { BUILT_IN_RECIPES } from '../../src/shared/recipeBuiltins'

const items = (menu: MenuEntry[]): MenuItem[] => menu.filter((e): e is MenuItem => e !== 'separator')

describe('paths keep the part that tells folders apart (audit #8)', () => {
  test('a worktree Patchbay made shows as its own folder, not the -worktrees fragment', () => {
    expect(placeLabel('C:\\Users\\me\\AppData\\Local\\Temp\\patchbay-scene-juQNNP-worktrees\\dark-mode', 'C:\\Users\\me\\AppData\\Local\\Temp\\patchbay-scene-juQNNP')).toBe('dark-mode')
    expect(placeLabel('C:\\src\\app-worktrees\\fix-login\\packages\\api')).toBe('fix-login\\packages\\api')
    expect(placeLabel('/home/me/app-worktrees/try-a')).toBe('try-a')
  })

  test('inside the project folder, the path from there; elsewhere the last two folders after …', () => {
    expect(placeLabel('C:\\repo\\packages\\api', 'C:\\repo')).toBe('packages\\api')
    expect(placeLabel('C:\\Users\\me\\AppData\\Local\\Temp\\patchbay-scene-tE8qRh', 'C:\\Users\\me\\app')).toBe('…\\Temp\\patchbay-scene-tE8qRh')
    expect(placeLabel('C:\\a\\b')).toBe('C:\\a\\b')
  })

  test('an ssh host and no folder are left as they are', () => {
    expect(placeLabel('ssh build-box')).toBe('ssh build-box')
    expect(placeLabel('')).toBe('')
  })
})

describe("a board column's … menu (audit #9)", () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const act = () => ({ startsWork: vi.fn<(on: boolean) => void>(), rename: vi.fn<() => void>(), move: vi.fn<(step: -1 | 1) => void>(), remove: vi.fn<() => void>() })

  test('names every action, with Remove last, apart and in the danger style', () => {
    const menu = boardColumnMenu({ title: 'To do' }, { index: 1, count: 4 }, act())
    expect(items(menu).map((i) => i.tool)).toEqual(['starts-work', 'rename', 'left', 'right', 'remove'])
    expect(menu[menu.length - 2]).toBe('separator')
    expect(items(menu).at(-1)).toMatchObject({ label: 'Remove column…', danger: true, disabled: false })
    for (const i of items(menu)) expect(i.icon, i.id).toBeTruthy()
  })

  test('cannot move past either end, or remove the only column', () => {
    const first = items(boardColumnMenu({ title: 'A' }, { index: 0, count: 2 }, act()))
    expect(first.find((i) => i.tool === 'left')?.disabled).toBe(true)
    expect(first.find((i) => i.tool === 'right')?.disabled).toBe(false)
    const only = items(boardColumnMenu({ title: 'A' }, { index: 0, count: 1 }, act()))
    expect(only.find((i) => i.tool === 'right')?.disabled).toBe(true)
    expect(only.find((i) => i.tool === 'remove')?.disabled).toBe(true)
  })

  test('each row runs its action; the starts-work row is a toggle showing its state', () => {
    const a = act()
    const menu = items(boardColumnMenu({ title: 'A', startsWork: true }, { index: 1, count: 3 }, a))
    expect(menu[0].checked).toBe(true)
    for (const i of menu) i.run()
    expect(a.startsWork).toHaveBeenCalledWith(false)
    expect(a.move.mock.calls).toEqual([[-1], [1]])
    expect(a.rename).toHaveBeenCalledOnce()
    expect(a.remove).toHaveBeenCalledOnce()
  })
})

describe('the folded Task outcomes line (audit #9)', () => {
  test('counts tasks by state, what needs the person first', () => {
    expect(outcomeSummary([{ state: 'running' }, { state: 'ready-for-review' }, { state: 'running' }, { state: 'accepted' }])).toBe('1 submitted · 2 running · 1 accepted')
    expect(outcomeSummary([])).toBe('')
  })
})

describe('ids stay out of body text (audit #17)', () => {
  test('a UUID is opaque; a slug is not', () => {
    expect(isOpaqueId('4d7e8252-766a-4d9a-912f-b112155f0566')).toBe(true)
    expect(isOpaqueId('checkout-check')).toBe(false)
  })

  test("a browser check names its task by the task's brief, never by a UUID", () => {
    expect(evidenceTaskLabel(undefined, undefined)).toBeNull()
    expect(evidenceTaskLabel('4d7e8252-766a-4d9a-912f-b112155f0566', 'Fix checkout')).toBe('For the task "Fix checkout"')
    expect(evidenceTaskLabel('4d7e8252-766a-4d9a-912f-b112155f0566', undefined)).toBe('For a task')
    expect(evidenceTaskLabel('checkout-check', undefined)).toBe('For the task checkout-check')
  })

  test("the built-in recipe's brief names its agents without their node ids", () => {
    const brief = BUILT_IN_RECIPES[0].nodes.find((n) => n.key === 'brief') as unknown as { text: string }
    expect(brief.text).toContain('- Implementer: Claude\n')
    expect(brief.text).not.toMatch(/\{\{\s*node:/)
  })
})

describe('a Files shelf row (audit #24)', () => {
  test('keeps one … menu with every action, Forget last and apart', () => {
    const act = { open: vi.fn(), reveal: vi.fn(), copy: vi.fn(), pin: vi.fn(), send: vi.fn(), forget: vi.fn() }
    const menu = shelfRowMenu(act)
    expect(items(menu).map((i) => i.label)).toEqual(['Open', 'Reveal in File Explorer', 'Copy path', 'Pin to canvas', 'Send path to agent…', 'Forget (the file stays)'])
    expect(menu[menu.length - 2]).toBe('separator')
    for (const i of items(menu)) i.run()
    for (const fn of Object.values(act)) expect(fn).toHaveBeenCalledOnce()
  })
})

describe('View > Minimap (audit #28)', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const act = () => ({ togglePref: vi.fn<() => void>(), toggleFolded: vi.fn<() => void>() })

  const ticked = (on: boolean, foldMap: boolean, mapOpen: boolean): boolean => minimapItems(on, { foldMap, mapOpen }, act()).some((i) => i.checked)

  test('ticked only while a map is drawn', () => {
    expect(ticked(true, false, false)).toBe(true)
    expect(ticked(true, true, false)).toBe(false)
    expect(ticked(true, true, true)).toBe(true)
    expect(ticked(false, true, false)).toBe(false)
  })

  test('folded into the dock, it shows and hides the map from there, as the dock button does', () => {
    const a = act()
    const [show, off] = minimapItems(true, { foldMap: true, mapOpen: false }, a)
    expect(show.label).toContain('in the dock')
    show.run()
    expect(a.toggleFolded).toHaveBeenCalledOnce()
    expect(a.togglePref).not.toHaveBeenCalled()
    const b = act()
    minimapItems(true, { foldMap: false, mapOpen: false }, b)[0].run()
    expect(b.togglePref).toHaveBeenCalledOnce()
  })

  test('folded, it can still be turned off, by the row with the id the shortcut and palette use', () => {
    const a = act()
    const rows = minimapItems(true, { foldMap: true, mapOpen: true }, a)
    expect(rows.map((r) => r.id)).toEqual(['show-folded-map', 'toggle-minimap'])
    expect(rows[1]).toMatchObject({ label: 'Turn the minimap off' })
    rows[1].run()
    expect(a.togglePref).toHaveBeenCalledOnce()
  })
})

describe('Check for updates by itself (audit #29)', () => {
  test('off and locked, saying why, while there is no update feed', () => {
    expect(updateCheckRow('', undefined)).toMatchObject({ checked: false, disabled: true })
    expect(updateCheckRow('  ', '')).toMatchObject({ checked: false, disabled: true })
    expect(updateCheckRow(undefined, undefined).help).toMatch(/update feed/)
  })

  test('with a feed, it follows the stored choice', () => {
    expect(updateCheckRow('github:me/app', undefined)).toMatchObject({ checked: true, disabled: false })
    expect(updateCheckRow('github:me/app', 'off')).toMatchObject({ checked: false, disabled: false })
  })
})
