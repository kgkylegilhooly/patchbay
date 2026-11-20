import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain } from 'electron'
import type { GitService } from '../../core/git/service'
import type { CanvasStore, NodeMessage } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import type { SearchBridge } from '../../shared/searchBridge'
import { createHandoffSaver } from './saveHandoff'
import { createSearchService, workerBackend } from './service'

/** The repository a folder is in, and its uncommitted files, from the same git the git panel uses. */
export function gitChangesWith(git: GitService) {
  return async (folder: string): Promise<{ root: string; changed: string[] } | { unavailable: string }> => {
    const root = await git.toplevel(folder)
    if (!root) return { unavailable: `${folder} isn't in a git repository` }
    const s = await git.status(root)
    return { root, changed: [...new Set([...s.staged, ...s.unstaged, ...s.conflicts].map((e) => e.path))] }
  }
}

/**
 * The worker's script. Node can't start a worker from inside app.asar, so an installed build unpacks it, with the
 * chunks it loads (see asarUnpack in package.json), and it's loaded from app.asar.unpacked.
 */
export function workerScript(mainDir: string): string {
  return join(mainDir, 'searchWorker.js').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/**
 * Starts search and serves `pb:search:*` (see src/preload/search.ts). Only the window calls these; the control server
 * has no route to them, so agents get no search of their own.
 */
export function registerSearchIpc(s: {
  dataDir: string
  mainDir: string
  store: CanvasStore
  messages: () => NodeMessage[]
  status: (id: string) => AgentStatus | undefined
  git: GitService
  startNode: (id: string) => Promise<void>
  log?: (line: string) => void
}): { stop(): Promise<void> } {
  const service = createSearchService({
    store: s.store,
    messages: s.messages,
    status: s.status,
    gitChanges: gitChangesWith(s.git),
    startNode: s.startNode,
    backend: workerBackend(workerScript(s.mainDir), join(s.dataDir, 'search', 'index.json'), (line) => (s.log ?? console.error)(line))
  })
  const methods: (keyof typeof service)[] = ['search', 'stats', 'readSource', 'rebuild', 'prepareHandoff', 'startHandoff']
  for (const name of methods) {
    ipcMain.handle(`pb:search:${name}`, (_e, ...args: unknown[]) => (service[name] as (...a: unknown[]) => unknown)(...args))
  }
  const saveHandoff = createHandoffSaver({
    store: s.store,
    home: homedir(),
    writeFile: (p, text, exclusive) => writeFile(p, text, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' }),
    async pickFile(defaultPath) {
      // Screenshot scenes answer the dialog this way (see test/acceptance/readerPictureScenes.cjs). Never when installed.
      if (!app.isPackaged && process.env.PB_SCENE_SAVE_AS) return process.env.PB_SCENE_SAVE_AS
      const r = await dialog.showSaveDialog({ title: 'Save the handoff', defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      return r.canceled || !r.filePath ? null : r.filePath
    }
  })
  ipcMain.handle('pb:search:saveHandoff', (_e, a: unknown) => saveHandoff(a as never))
  service.start()
  return { stop: () => service.stop() }
}
