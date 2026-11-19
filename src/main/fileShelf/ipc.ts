import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { isShelfEntry, type FileCheckItem, type ShelfEntry } from '../../shared/fileShelf'
import type { CanvasStore } from '../../shared/contract'
import { checkFiles, openFile, revealFile, type FileDeps } from './files'
import { FileShelfStore } from './store'

const deps: FileDeps = {
  kind: async (path) => {
    try {
      return (await stat(path)).isDirectory() ? 'folder' : 'file'
    } catch {
      return null
    }
  },
  openPath: (path) => shell.openPath(path),
  reveal: (path) => shell.showItemInFolder(path)
}

/**
 * The Files shelf and file icons' calls, on `pb:files:<method>`. Only the app's own page may make them: a web page in a
 * browser node has no way to open or list files.
 */
export function registerFileShelfIpc(s: {
  dataDir: string
  store: CanvasStore
  isAppUi: (e: IpcMainInvokeEvent) => boolean
  windows: () => WebContents[]
  log?: (line: string) => void
}): FileShelfStore {
  const shelf = new FileShelfStore(join(s.dataDir, 'file-shelf.json'), { log: s.log })
  if (shelf.loadProblem) s.log?.(shelf.loadProblem)
  shelf.keepOnly(s.store.get().projects.map((p) => p.id))
  shelf.onChange((projectId) => {
    for (const w of s.windows()) if (!w.isDestroyed()) w.send('pb:files:changed', projectId)
  })

  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`pb:files:${name}`, (e, ...args: unknown[]) => {
      if (!s.isAppUi(e)) throw new Error('Files are available only in the application UI.')
      return fn(...args)
    })
  }
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')

  handle('list', (projectId) => shelf.list(text(projectId)))
  handle('note', (projectId, entries) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries.slice(0, 500)) if (isShelfEntry(entry)) shelf.note(text(projectId), entry as ShelfEntry)
  })
  handle('forget', (projectId, path) => shelf.forget(text(projectId), text(path)))
  handle('check', (items) => {
    if (!Array.isArray(items)) return {}
    const valid = items.filter((i): i is FileCheckItem => !!i && typeof (i as FileCheckItem).path === 'string')
    return checkFiles(valid.map((i) => ({ path: i.path, network: i.network === true })), deps)
  })
  handle('open', (path) => openFile(text(path), deps))
  handle('reveal', (path) => revealFile(text(path), deps))
  return shelf
}

/** Notes a file shared with or by a node, on the shelf of the node's project. Does nothing for a node that's gone. */
export function noteFromNode(shelf: FileShelfStore, store: CanvasStore, nodeId: string, path: string, source: ShelfEntry['source']): void {
  const node = store.get().nodes.find((n) => n.id === nodeId)
  if (!node?.projectId) return
  shelf.note(node.projectId, { path, source, at: Date.now(), nodeTitle: node.title })
}
