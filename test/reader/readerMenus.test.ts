import { describe, expect, it, vi } from 'vitest'
import { ACTIONS } from '../../src/renderer/actions'
import { canvasMenu, nodeMenu, type Commands, type MenuEntry, type MenuItem, type MenuState } from '../../src/renderer/menus'
import { pathMenu } from '../../src/renderer/pathMenu'
import type { ClaudeNode, ReaderNode, TerminalNode } from '../../src/shared/model'
import { isDocPath } from '../../src/shared/reader'

const commands = new Proxy({} as Commands, { get: () => vi.fn() })
const state: MenuState = { selectedCount: 0, canCopy: false, canFind: false, sidebar: true, minimap: true, legend: false, snap: false, canUndo: false, canRedo: false, hasWindow: false, canName: false, canCloseProject: true }
const ids = (entries: MenuEntry[]): string[] => entries.flatMap((e) => (e === 'separator' ? [] : [e.id]))
const base = { x: 0, y: 0, width: 10, height: 10, parentId: null }
const agent: ClaudeNode = { ...base, id: 'a', kind: 'claude', title: 'Planner', cwd: 'C:/w', sessionId: null, transcriptPath: null, after: [] }
const terminal: TerminalNode = { ...base, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:/w' }
const reader: ReaderNode = { ...base, id: 'r', kind: 'reader', title: 'Plan', path: 'C:/w/plan.md' }
const ctx = { at: { x: 1, y: 2 }, canCopy: false, canRestart: false }

describe('reader menus', () => {
  it('offers Open plan in Reader on agents only', () => {
    expect(ids(nodeMenu(commands, agent, 'idle', ctx))).toContain('open-plan')
    expect(ids(nodeMenu(commands, terminal, null, ctx))).not.toContain('open-plan')
  })

  it('gives a reader its own menu, closing undoably like a note', () => {
    const closeNode = vi.fn()
    const entries = nodeMenu({ ...commands, closeNode } as Commands, reader, null, ctx)
    expect(ids(entries)).toEqual(['reader-reveal', 'reader-copy-path', 'rename', 'close'])
    ;(entries.find((e) => e !== 'separator' && e.id === 'close') as MenuItem).run()
    expect(closeNode).toHaveBeenCalledWith('r')
  })

  it('opens documents from the canvas menu and the palette', () => {
    expect(ids(canvasMenu(commands, state, { x: 0, y: 0 }))).toContain('open-document')
    expect(ACTIONS.find((a) => a.id === 'open-document')).toMatchObject({ section: 'New', label: 'Open document…' })
  })

  it('offers Open in Reader first for a Markdown path in a terminal, and not for other files', () => {
    const act = { open: vi.fn(), newTerminal: vi.fn(), copy: vi.fn(), reveal: vi.fn() }
    expect(ids(pathMenu({ ...act, reader: vi.fn() }))[0]).toBe('path-reader')
    expect(ids(pathMenu(act))).not.toContain('path-reader')
  })

  it('knows a document path, with or without a line number', () => {
    expect(isDocPath('docs/plan.md')).toBe(true)
    expect(isDocPath('C:\\x\\README.MD:12:3')).toBe(true)
    expect(isDocPath('notes.txt')).toBe(true)
    expect(isDocPath('src/app.ts')).toBe(false)
  })
})
