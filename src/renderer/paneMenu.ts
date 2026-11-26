import { closePane, leaves, showIn, splitPane, type Pane, type PanePath } from './focusLayout'
import type { MenuEntry, MenuItem } from './menus'

/** A window that can be shown in a pane. */
export interface PaneChoice {
  id: string
  title: string
}

/** Where a window sits in the focus view's layout, or null when it isn't in a pane. */
export function panePathOf(root: Pane, nodeId: string): PanePath | null {
  return leaves(root).find((l) => l.nodeId === nodeId)?.path ?? null
}

/**
 * What the pane bar held, for a pane showing a window: its header has the room, so the pane needs no bar of its own.
 * Each row keeps the bar button's `data-focus` name as its tool, so checks find it by the same name.
 */
export function paneMenuEntries(root: Pane, path: PanePath, nodeId: string, choices: PaneChoice[], set: (layout: Pane) => void): MenuEntry[] {
  const shown = new Set(leaves(root).map((l) => l.nodeId))
  const only = path.length === 0
  const others = choices.filter((c) => c.id !== nodeId)
  const show: MenuItem = {
    id: 'focus-show',
    label: 'Show here instead',
    icon: 'grid',
    run: () => {},
    submenu: [
      ...others.map((c): MenuItem => ({ id: `focus-show:${c.id}`, label: shown.has(c.id) ? `${c.title} (in another pane)` : c.title, tool: `show-${c.id}`, run: () => set(showIn(root, path, c.id)) })),
      ...(others.length ? (['separator'] as const) : []),
      { id: 'focus-show:empty', label: 'Nothing (empty this pane)', tool: 'show-empty', run: () => set(showIn(root, path, null)) }
    ]
  }
  return [
    show,
    'separator',
    { id: 'focus-split-right', label: 'Split right', tool: 'split-right', run: () => set(splitPane(root, path, 'row')) },
    { id: 'focus-split-down', label: 'Split down', tool: 'split-down', run: () => set(splitPane(root, path, 'column')) },
    'separator',
    {
      id: 'focus-close-pane',
      label: only ? 'Empty this pane' : 'Take this pane out of the view',
      icon: 'minus',
      tool: 'close-pane',
      run: () => set(closePane(root, path))
    }
  ]
}
