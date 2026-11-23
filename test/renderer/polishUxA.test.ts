import { describe, expect, test, vi } from 'vitest'
import { closedProjectMenu, nodeMenu, projectMenu, type Commands, type MenuEntry, type MenuItem } from '../../src/renderer/menus'
import { namedQuestion } from '../../src/renderer/shell/confirmStore'
import { shortStopLabel, stopLook } from '../../src/renderer/status/status'
import { worktreeMenu } from '../../src/renderer/worktreeUi'
import type { AgentStop } from '../../src/shared/agentStop'
import type { CanvasNode } from '../../src/shared/model'

const commands = new Proxy({} as Commands, { get: () => vi.fn() })
const items = (menu: MenuEntry[]): MenuItem[] => menu.filter((e): e is MenuItem => e !== 'separator')
const find = (menu: MenuEntry[], id: string): MenuItem | undefined => items(menu).find((i) => i.id === id)

describe('confirmations name the thing they act on', () => {
  test('a question with a name, and none without one', () => {
    expect(namedQuestion('Delete', 'Website')).toBe('Delete "Website"?')
    expect(namedQuestion('End and restart', ' Dev server ')).toBe('End and restart "Dev server"?')
    expect(namedQuestion('Delete', '  ')).toBeUndefined()
    expect(namedQuestion('Delete', undefined)).toBeUndefined()
  })

  test('Delete project… asks about that project, from its tab and from the closed list', () => {
    const ctx = { sessionTitles: [], items: 0, canClose: true, last: false, rename: () => {} }
    expect(find(projectMenu(commands, 'p', { ...ctx, name: 'Website' }), 'delete-project')?.confirmTitle).toBe('Delete "Website"?')
    expect(find(closedProjectMenu(commands, 'p', { sessionTitles: [], items: 0, name: 'Billing API' }), 'delete-project')?.confirmTitle).toBe('Delete "Billing API"?')
    // Without a name it falls back to the label's own question.
    expect(find(projectMenu(commands, 'p', ctx), 'delete-project')?.confirmTitle).toBeUndefined()
  })
})

describe('a stop in a narrow row keeps its time', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime()
  const limit: AgentStop = { kind: 'usage-limit', at: now, until: now + 30 * 60_000, message: null, holds: 'reset' }

  test('"Usage limit until 12:30" becomes "Limit until 12:30", with the full words in the tooltip', () => {
    const look = stopLook(limit, now)
    expect(look.label).toMatch(/^Usage limit until /)
    expect(look.short).toBe(look.label.replace('Usage limit', 'Limit'))
    expect(look.detail).toContain(look.label)
  })

  test('"continues then" gives way first; a short stop has no short form', () => {
    expect(shortStopLabel('Usage limit until 00:30 · continues then')).toBe('Limit until 00:30')
    expect(stopLook({ ...limit, kind: 'auth', until: null, holds: 'person' }, now).short).toBeUndefined()
  })
})

describe('Remove worktree… is in the group\'s menus, not a red button on its header', () => {
  const bound: CanvasNode = { id: 'g', kind: 'group', title: 'Backend', x: 0, y: 0, width: 600, height: 400, parentId: null, worktree: { repo: 'C:\r', branch: 'dark-mode', path: 'C:\r-wt\dark-mode' } }

  test('the ⋯ menu ends with it, apart and marked as danger', () => {
    const menu = worktreeMenu('g', { branch: 'dark-mode', path: 'C:\r-wt\dark-mode' })
    expect(menu[menu.length - 1]).toMatchObject({ id: 'remove-worktree', danger: true })
    expect(menu[menu.length - 2]).toBe('separator')
  })

  test('the right-click menu has it only for a bound group', () => {
    expect(find(nodeMenu(commands, bound, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }), 'remove-worktree')?.danger).toBe(true)
    expect(find(nodeMenu(commands, { ...bound, worktree: null }, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }), 'remove-worktree')).toBeUndefined()
  })
})
