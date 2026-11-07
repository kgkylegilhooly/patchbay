import type { MenuEntry } from './menus'

/** What clicking a path in a terminal offers. */
export function pathMenu(act: { open: () => void; newTerminal: () => void; copy: () => void; reveal: () => void }): MenuEntry[] {
  return [
    { id: 'path-open', label: 'Open', icon: 'arrow-right', run: act.open },
    'separator',
    { id: 'path-new-terminal', label: 'New terminal here', icon: 'terminal', run: act.newTerminal },
    'separator',
    { id: 'path-copy', label: 'Copy path', icon: 'copy', run: act.copy },
    { id: 'path-reveal', label: 'Show in File Explorer', icon: 'folder-open', run: act.reveal }
  ]
}
