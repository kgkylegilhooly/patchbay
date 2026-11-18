import { describe, expect, it } from 'vitest'
import { actionById } from '../../src/renderer/actions'
import { nodeMenu, type Commands, type MenuItem } from '../../src/renderer/menus'
import { markedParts, rangeStart, useSearchUi } from '../../src/renderer/searchUi'
import type { ClaudeNode, TerminalNode } from '../../src/shared/model'

const commands = new Proxy({}, { get: () => () => {} }) as unknown as Commands
const base = { x: 0, y: 0, width: 100, height: 100, parentId: null, cwd: 'C:\\w', title: 'Fix the parser' }
const ctx = { at: { x: 0, y: 0 }, canCopy: false, canRestart: true }

describe('search UI', () => {
  it('cuts a snippet into plain and marked parts, ignoring marks out of range', () => {
    expect(markedParts('one two three', [[4, 7], [20, 25]])).toEqual([
      { text: 'one ', mark: false },
      { text: 'two', mark: true },
      { text: ' three', mark: false }
    ])
  })

  it('turns a date filter into the earliest time it lets through', () => {
    const now = Date.UTC(2026, 10, 18)
    expect(rangeStart('any', now)).toBeUndefined()
    expect(rangeStart('week', now)).toBe(now - 7 * 24 * 3600_000)
  })

  it('opens search from the palette, with its own shortcut', () => {
    const action = actionById('search')!
    expect(action).toMatchObject({ section: 'View', key: 'Ctrl+Shift+S' })
    useSearchUi.setState({ open: false })
    action.run(commands)
    expect(useSearchUi.getState().open).toBe(true)
  })

  it("offers Continue with another agent on an agent window's menu, and nowhere else", () => {
    const agent: ClaudeNode = { ...base, id: 'a1', kind: 'claude', sessionId: null, transcriptPath: null, after: [] }
    const terminal: TerminalNode = { ...base, id: 't1', kind: 'terminal' }
    const item = nodeMenu(commands, agent, 'idle', ctx).find((e): e is MenuItem => e !== 'separator' && e.id === 'continue-handoff')!
    expect(item.label).toBe('Continue with another agent…')
    item.run()
    expect(useSearchUi.getState().handoff).toEqual({ type: 'node', nodeId: 'a1', title: 'Fix the parser' })
    expect(nodeMenu(commands, terminal, null, ctx).some((e) => e !== 'separator' && e.id === 'continue-handoff')).toBe(false)
  })
})
