import { describe, expect, test, vi } from 'vitest'
import type { MenuItem } from '../../src/renderer/menus'
import { pathMenu } from '../../src/renderer/pathMenu'
import { openTerminalBeside, useStore } from '../../src/renderer/store'

// The store is loaded with the file, not inside a test: no other file loads its module graph, and transforming it cold
// inside a test body, as this did, took past vitest's 5 s on a loaded machine. The bridge to main is what it calls.
const bridgeCalls = vi.hoisted(() => ({ started: [] as string[], added: [] as unknown[] }))
vi.mock('../../src/renderer/bridge', () => ({
  bridge: { startNode: async (id: string) => void bridgeCalls.started.push(id), dispatch: async (op: { node: unknown }) => void bridgeCalls.added.push(op.node) }
}))

describe('pathMenu', () => {
  test('offers open, a terminal there, copy and reveal, each running its own action', () => {
    const act = { open: vi.fn(), newTerminal: vi.fn(), copy: vi.fn(), reveal: vi.fn() }
    const items = pathMenu(act).filter((e): e is MenuItem => e !== 'separator')
    expect(items.map((i) => i.label)).toEqual(['Open', 'New terminal here', 'Copy path', 'Show in File Explorer'])
    for (const item of items) item.run()
    for (const fn of Object.values(act)) expect(fn).toHaveBeenCalledTimes(1)
  })

  test('offers a terminal there with each other profile; plain New terminal here opens the default', () => {
    const act = { open: vi.fn(), newTerminal: vi.fn(), copy: vi.fn(), reveal: vi.fn(), profiles: [{ id: 'custom:vs', name: 'VS prompt' }, { id: 'builtin:wsl', name: 'WSL' }] }
    const items = pathMenu(act).filter((e): e is MenuItem => e !== 'separator')
    expect(items.map((i) => i.label)).toEqual(['Open', 'New terminal here', 'New terminal here with', 'Copy path', 'Show in File Explorer'])
    items[1].run()
    for (const p of items[2].submenu as MenuItem[]) p.run()
    expect(act.newTerminal.mock.calls).toEqual([[], ['custom:vs'], ['builtin:wsl']])
  })
})

describe('a terminal opened from a path', () => {
  test('opens in that folder, with the picked profile recorded, or none for the default (main stamps it at start)', () => {
    const { started, added } = bridgeCalls
    useStore.setState({ doc: { version: 3, projects: [{ id: 'p', name: 'P', folder: 'C:\\', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p', nodes: [{ id: 'src', kind: 'terminal', title: 'T', x: 0, y: 0, width: 600, height: 400, parentId: 'g', cwd: 'C:\\repo', projectId: 'p' }], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } } as never })
    const withProfile = openTerminalBeside('src', 'C:\\repo\\docs', { id: 'custom:vs', name: 'VS prompt' })
    const plain = openTerminalBeside('src', 'C:\\repo\\docs')
    const nodes = added as Array<{ id: string }>
    expect(nodes.find((n) => n.id === withProfile)).toMatchObject({ kind: 'terminal', cwd: 'C:\\repo\\docs', profile: 'custom:vs', title: 'VS prompt', parentId: null })
    expect(started).toEqual([withProfile, plain])
    const p = nodes.find((n) => n.id === plain)!
    expect(p).toMatchObject({ kind: 'terminal', cwd: 'C:\\repo\\docs', title: 'Terminal' })
    expect('profile' in p).toBe(false)
  })
})
