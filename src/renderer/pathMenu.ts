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

/**
 * What clicking a path in a terminal offers. A Markdown file can also open in a reader on the canvas. New terminal here
 * opens the default profile; each other profile has its own entry, as on the canvas menu. The path is the folder
 * either way, as a folder chosen for `patchbay open-terminal` comes before a profile's own.
 */
export function pathMenu(act: {
  open: () => void
  newTerminal: (profileId?: string) => void
  copy: () => void
  reveal: () => void
  reader?: () => void
  /** Profiles other than the default. */
  profiles?: Array<{ id: string; name: string }>
}): MenuEntry[] {
  return [
    ...(act.reader ? [{ id: 'path-reader', label: 'Open in Reader', icon: 'note' as const, run: act.reader }] : []),
    { id: 'path-open', label: 'Open', icon: 'arrow-right', run: act.open },
    'separator',
    { id: 'path-new-terminal', label: 'New terminal here', icon: 'terminal', run: () => act.newTerminal() },
    ...(act.profiles ?? []).map((p) => ({ id: `path-new-terminal:${p.id}`, label: `New terminal here: ${p.name}`, icon: 'terminal' as const, run: () => act.newTerminal(p.id) })),
    'separator',
    { id: 'path-copy', label: 'Copy path', icon: 'copy', run: act.copy },
    { id: 'path-reveal', label: 'Show in File Explorer', icon: 'folder-open', run: act.reveal }
  ]
}
