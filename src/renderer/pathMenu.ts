import type { MenuEntry } from './menus'

/**
 * What right-clicking a web link offers. Copy is there for a PC whose security settings stop links opening in a
 * browser from another app: the link can be pasted into the browser instead.
 */
export function linkMenu(act: { open: () => void; copy: () => void }): MenuEntry[] {
  return [
    { id: 'link-open', label: 'Open link', icon: 'arrow-right', run: act.open },
    { id: 'link-copy', label: 'Copy link', icon: 'copy', run: act.copy }
  ]
}

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
