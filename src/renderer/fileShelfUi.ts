import { create } from 'zustand'
import { isNetworkPath, pathKey, type FileCheckItem, type FileShelfBridge, type FileState, type ShelfEntry } from '../shared/fileShelf'
import type { FileNode } from '../shared/model'
import type { MenuEntry, MenuItem } from './menus'

/**
 * The Files shelf's state and the file actions menus offer. Kept free of the page's bridge and store at load, so menus
 * and the palette can use it where there's no window, as in tests. What needs the canvas is in fileShelfActions.ts.
 */

declare global {
  interface Window {
    patchbayFileShelf?: FileShelfBridge
  }
}

export const filesBridge = (): FileShelfBridge | undefined => (typeof window === 'undefined' ? undefined : window.patchbayFileShelf)

interface FilesUi {
  open: boolean
  /** The path "Send path to agent" is choosing an agent for. */
  sendPath: string | null
  /** A short line about the last file action, such as why a file didn't open. */
  notice: string | null
  /** What each file looked like when last checked, by pathKey. */
  states: Record<string, FileState>
}

export const useFilesUi = create<FilesUi>(() => ({ open: false, sendPath: null, notice: null, states: {} }))

export function toggleFileShelf(): void {
  useFilesUi.setState((s) => ({ open: !s.open }))
}

export function closeFileShelf(): void {
  useFilesUi.setState({ open: false })
}

export function askSendPath(path: string): void {
  useFilesUi.setState({ sendPath: path })
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
export function fileNotice(text: string | null): void {
  clearTimeout(noticeTimer)
  useFilesUi.setState({ notice: text })
  if (text) noticeTimer = setTimeout(() => useFilesUi.setState((s) => (s.notice === text ? { notice: null } : s)), 4500)
}

export function stateOf(states: Record<string, FileState>, path: string): FileState | undefined {
  return states[pathKey(path)]
}

// Checks asked for in the same moment go to main as one batch.
let pending = new Map<string, FileCheckItem>()
let flushing: ReturnType<typeof setTimeout> | null = null

/** Looks at these files again, soon and together. `network` marks one the person added, which may be on a share. */
export function checkFiles(items: FileCheckItem[]): void {
  for (const item of items) {
    const key = pathKey(item.path)
    const had = pending.get(key)
    pending.set(key, { path: item.path, network: !!(had?.network || item.network) })
  }
  if (flushing || !pending.size) return
  flushing = setTimeout(() => {
    const batch = [...pending.values()]
    pending = new Map()
    flushing = null
    void filesBridge()
      ?.check(batch)
      .then((found) => {
        const next: Record<string, FileState> = {}
        for (const [path, state] of Object.entries(found)) next[pathKey(path)] = state
        useFilesUi.setState((s) => ({ states: { ...s.states, ...next } }))
      })
      .catch(() => {})
  }, 30)
}

/** A file icon the person made may be on a network share; one an agent pinned never is. */
export const personMade = (node: FileNode): boolean => !node.openedBy

export function forgetShared(projectId: string, path: string): void {
  void filesBridge()?.forget(projectId, path)
}

export async function listShared(projectId: string): Promise<ShelfEntry[]> {
  return (await filesBridge()?.list(projectId)) ?? []
}

export function openFile(path: string): void {
  void filesBridge()
    ?.open(path)
    .then((r) => {
      if (!r.ok) {
        fileNotice(r.reason)
        checkFiles([{ path, network: isNetworkPath(path) }])
      } else fileNotice(r.revealed ? 'This file runs a program, so Patchbay showed it in File Explorer instead of opening it.' : null)
    })
}

export function revealFile(path: string): void {
  void filesBridge()
    ?.reveal(path)
    .then((r) => fileNotice(r.ok ? null : r.reason))
}

/** Through Electron's clipboard first, as clipboard.ts does: the page's own can be refused when the window isn't focused. */
export function copyPath(path: string): void {
  const viaApp = async (): Promise<void> => {
    try {
      await (window as unknown as { patchbay: { writeClipboard(text: string): Promise<void> } }).patchbay.writeClipboard(path)
    } catch {
      await navigator.clipboard.writeText(path)
    }
  }
  void viaApp().then(
    () => fileNotice('Path copied.'),
    (e: unknown) => fileNotice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`)
  )
}

/** A file icon's own menu: what a desktop icon's would have, in Patchbay's words. */
export function fileNodeMenu(node: FileNode, remove: MenuItem): MenuEntry[] {
  return [
    { id: 'file-open', label: 'Open', icon: 'arrow-right', run: () => openFile(node.path) },
    { id: 'file-reveal', label: 'Reveal in File Explorer', icon: 'folder-open', run: () => revealFile(node.path) },
    { id: 'file-copy-path', label: 'Copy path', icon: 'copy', run: () => copyPath(node.path) },
    { id: 'file-send', label: 'Send path to agent…', icon: 'claude', run: () => askSendPath(node.path) },
    'separator',
    { ...remove, label: 'Remove from canvas', confirm: undefined }
  ]
}
