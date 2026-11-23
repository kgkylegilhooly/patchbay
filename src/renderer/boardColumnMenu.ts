import type { MenuEntry } from './menus'

/**
 * A board column's `…` menu. Its actions used to be five text glyphs on every column head, with Remove beside the move
 * arrows; here they are named rows, and Remove is last, apart, in the danger style. Remove asks in its own dialog.
 */
export function boardColumnMenu(
  col: { title: string; startsWork?: boolean },
  at: { index: number; count: number },
  act: { startsWork: (on: boolean) => void; rename: () => void; move: (step: -1 | 1) => void; remove: () => void }
): MenuEntry[] {
  return [
    { id: 'column-starts-work', label: 'Offer to start Claude on an issue dropped here', icon: 'claude', checked: !!col.startsWork, tool: 'starts-work', run: () => act.startsWork(!col.startsWork) },
    { id: 'column-rename', label: 'Rename', icon: 'edit', tool: 'rename', run: act.rename },
    { id: 'column-left', label: 'Move left', icon: 'arrow-left', tool: 'left', disabled: at.index === 0, run: () => act.move(-1) },
    { id: 'column-right', label: 'Move right', icon: 'arrow-right', tool: 'right', disabled: at.index === at.count - 1, run: () => act.move(1) },
    'separator',
    { id: 'column-remove', label: 'Remove column…', icon: 'trash', tool: 'remove', danger: true, disabled: at.count === 1, run: act.remove }
  ]
}
