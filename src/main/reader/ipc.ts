import { existsSync, unwatchFile, watchFile, type Stats } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dialog, ipcMain, shell } from 'electron'
import type { CanvasStore } from '../../shared/contract'
import type { CanvasDoc, CanvasNode } from '../../shared/model'
import { DOC_EXTENSIONS, type DocsBridge } from '../../shared/reader'
import { createCommentStore, type CommentStore } from './commentStore'
import { createImageReader } from './images'
import { createDocsService, type DocsService, type DocsWatcher } from './service'
import { viewSize } from '../viewSize'

/** How often a watched file is looked at. Cheap: one stat per open reader. */
const WATCH_INTERVAL_MS = 1000

/** fs.watchFile, which keeps working when an editor saves by replacing the file, and when it's deleted and comes back. */
export function pollingWatcher(): DocsWatcher {
  const listeners = new Map<string, (cur: Stats, prev: Stats) => void>()
  return {
    watch(path, changed) {
      const listener = (cur: Stats, prev: Stats): void => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) changed()
      }
      listeners.set(path, listener)
      watchFile(path, { interval: WATCH_INTERVAL_MS, persistent: false }, listener)
    },
    unwatch(path) {
      const listener = listeners.get(path)
      if (listener) unwatchFile(path, listener)
      listeners.delete(path)
    }
  }
}

/**
 * Starts the reader's service and serves `pb:docs:*` (see src/preload/docs.ts). Only the person's window calls these;
 * agents reach readers only through the `open-doc` and `read` verbs (see ./verbs.ts).
 */
export function registerDocsIpc(s: {
  dataDir: string
  store: CanvasStore
  broadcast: (channel: string, ...args: unknown[]) => void
  near: (doc: CanvasDoc, opener: CanvasNode, size: { width: number; height: number }) => { x: number; y: number }
}): { service: DocsService; comments: CommentStore; stop(): void } {
  const comments = createCommentStore(join(s.dataDir, 'reader'))
  const service = createDocsService({
    store: s.store,
    dataDir: s.dataDir,
    home: homedir(),
    comments,
    fs: {
      realpath: (p) => realpath(p),
      stat: (p) => stat(p),
      readFile: (p) => readFile(p, 'utf8'),
      writeFile: (p, text) => writeFile(p, text, 'utf8'),
      mkdir: async (p) => void (await mkdir(p, { recursive: true })),
      exists: existsSync
    },
    watcher: pollingWatcher(),
    changed: (path) => s.broadcast('pb:docs:changed', path),
    center: (id) => s.broadcast('pb:onCenterNode', id),
    view: viewSize,
    near: s.near,
    link: { exists: existsSync, openExternal: (url) => shell.openExternal(url), openPath: (p) => shell.openPath(p), reveal: (p) => shell.showItemInFolder(p) }
  })

  const handlers: { [K in keyof DocsBridge]: (...args: Parameters<DocsBridge[K]>) => unknown } = {
    read: (nodeId) => service.read(nodeId),
    open: (a) => service.open(a),
    async pick(at) {
      const r = await dialog.showOpenDialog({
        title: 'Open a document in a reader',
        properties: ['openFile'],
        filters: [{ name: 'Markdown and text', extensions: DOC_EXTENSIONS.map((e) => e.slice(1)) }]
      })
      if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true, reason: 'Nothing was picked.' }
      return service.open({ path: r.filePaths[0], ...(at ? { at } : {}) })
    },
    openPlan: (agentId) => service.openPlan(agentId),
    comments: (nodeId) => service.comments(nodeId),
    saveComments: (nodeId, list) => service.saveComments(nodeId, list),
    openLink: (nodeId, href) => service.openLink(nodeId, href),
    image: createImageReader({ store: s.store, home: homedir() })
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`pb:docs:${name}`, (_e, ...args: unknown[]) => (handler as (...a: unknown[]) => unknown)(...args))
  }
  return { service, comments, stop: () => service.stop() }
}
