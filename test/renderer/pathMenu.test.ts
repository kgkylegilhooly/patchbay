import { describe, expect, test, vi } from 'vitest'
import type { MenuItem } from '../../src/renderer/menus'
import { pathMenu } from '../../src/renderer/pathMenu'

describe('pathMenu', () => {
  test('offers open, a terminal there, copy and reveal, each running its own action', () => {
    const act = { open: vi.fn(), newTerminal: vi.fn(), copy: vi.fn(), reveal: vi.fn() }
    const items = pathMenu(act).filter((e): e is MenuItem => e !== 'separator')
    expect(items.map((i) => i.label)).toEqual(['Open', 'New terminal here', 'Copy path', 'Show in File Explorer'])
    for (const item of items) item.run()
    for (const fn of Object.values(act)) expect(fn).toHaveBeenCalledTimes(1)
  })
})
