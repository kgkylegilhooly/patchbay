import type { MenuEntry } from './menus'

/**
 * A Files shelf row's `…` menu (and its right-click menu). The row itself opens the file; the rest used to be five
 * faint icon buttons on every row. Forget is last and apart: it drops the shelf's reference, never the file.
 */
export function shelfRowMenu(act: { open: () => void; reveal: () => void; copy: () => void; pin: () => void; send: () => void; forget: () => void }): MenuEntry[] {
  return [
    { id: 'shelf-open', label: 'Open', icon: 'arrow-right', run: act.open },
    { id: 'shelf-reveal', label: 'Reveal in File Explorer', icon: 'folder-open', run: act.reveal },
    { id: 'shelf-copy-path', label: 'Copy path', icon: 'copy', run: act.copy },
    { id: 'shelf-pin', label: 'Pin to canvas', icon: 'pin', run: act.pin },
    { id: 'shelf-send', label: 'Send path to agent…', icon: 'claude', run: act.send },
    'separator',
    { id: 'shelf-forget', label: 'Forget (the file stays)', icon: 'close', run: act.forget }
  ]
}
