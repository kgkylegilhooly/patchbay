import { describe, expect, it } from 'vitest'
import { initialLayout, leaves, type Pane } from '../../src/renderer/focusLayout'
import type { MenuEntry, MenuItem } from '../../src/renderer/menus'
import { paneMenuEntries, panePathOf } from '../../src/renderer/paneMenu'

const items = (entries: MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => e !== 'separator')
const byTool = (entries: MenuEntry[], tool: string): MenuItem => {
  const found = items(entries).find((e) => e.tool === tool)
  if (!found) throw new Error(`no ${tool}`)
  return found
}
const choices = [
  { id: 'one', title: 'Fix the login' },
  { id: 'two', title: 'Write tests' },
  { id: 'three', title: 'Dev shell' }
]

function menu(root: Pane, nodeId: string): { entries: MenuEntry[]; set: () => Pane | null } {
  let last: Pane | null = null
  const path = panePathOf(root, nodeId)
  if (!path) throw new Error('not in a pane')
  return { entries: paneMenuEntries(root, path, nodeId, choices, (l) => (last = l)), set: () => last }
}

describe('the pane menu in a window header', () => {
  it('finds where a window sits, and nothing for one not in the view', () => {
    const root = initialLayout(['one', 'two'])
    expect(panePathOf(root, 'two')).toEqual(leaves(root).find((l) => l.nodeId === 'two')!.path)
    expect(panePathOf(root, 'three')).toBeNull()
  })

  it('splits right and down, keeping the bar buttons\' names as tools', () => {
    const root = initialLayout(['one', 'two'])
    const right = menu(root, 'one')
    byTool(right.entries, 'split-right').run()
    expect(leaves(right.set()!).map((l) => l.nodeId)).toEqual(['one', null, 'two'])
    const down = menu(root, 'two')
    byTool(down.entries, 'split-down').run()
    expect(leaves(down.set()!).map((l) => l.nodeId)).toEqual(['one', 'two', null])
  })

  it('lists the other windows to show here, marking those already in a pane, and can empty it', () => {
    const root = initialLayout(['one', 'two'])
    const { entries, set } = menu(root, 'one')
    const show = items(entries).find((e) => e.id === 'focus-show')!
    const rows = items(show.submenu!)
    expect(rows.map((r) => r.label)).toEqual(['Write tests (in another pane)', 'Dev shell', 'Nothing (empty this pane)'])
    rows.find((r) => r.tool === 'show-three')!.run()
    expect(leaves(set()!).map((l) => l.nodeId)).toEqual(['three', 'two'])
    rows.find((r) => r.tool === 'show-empty')!.run()
    expect(leaves(set()!).map((l) => l.nodeId)).toEqual([null, 'two'])
  })

  it('takes a pane out of the view, or only empties the last one', () => {
    const two = menu(initialLayout(['one', 'two']), 'two')
    expect(byTool(two.entries, 'close-pane').label).toBe('Take this pane out of the view')
    byTool(two.entries, 'close-pane').run()
    expect(leaves(two.set()!).map((l) => l.nodeId)).toEqual(['one'])
    const alone = menu(initialLayout(['one']), 'one')
    expect(byTool(alone.entries, 'close-pane').label).toBe('Empty this pane')
  })
})
