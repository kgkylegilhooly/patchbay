import { ipcMain, session } from 'electron'
import { join } from 'node:path'
import { fileNameFor } from '../../core/persist/scrollbackStore'
import { AGENT_PARTITION, BROWSER_PARTITIONS, PERSON_PARTITION } from '../../shared/browserPolicy'
import type { CanvasStore } from '../../shared/contract'
import type { ArchiveOptions, StorageReport } from '../../shared/projects'
import { createProjectArchiver } from './archive'
import { fileInfo, folderBytes, measureProjects } from './storage'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const partitionDir = (dataDir: string, partition: string): string => join(dataDir, 'Partitions', partition.replace(/^persist:/, ''))

/**
 * Serves `pb:projects:*`, the projects manager's and the archive confirmation's channels. See src/preload/projects.ts.
 * Archiving goes through here, never the page's plain dispatch, so a project's sessions are always stopped first.
 */
export function setupProjects({
  dataDir,
  store,
  isRunning,
  stopNode,
  disarmTrigger,
  forgetOutput
}: {
  dataDir: string
  store: CanvasStore
  isRunning(id: string): boolean
  stopNode(id: string): Promise<void>
  disarmTrigger(id: string): void
  /** Stops saving the node's output, drops what the host holds of it and removes its saved file. */
  forgetOutput(id: string): Promise<void>
}): void {
  const scrollbackPath = (id: string): string => join(dataDir, 'scrollback', fileNameFor(id))
  // Sizes are read when the preview is built, which is shown before archiving, so a cached copy is fine there.
  const sizes = new Map<string, number>()
  const archiver = createProjectArchiver({
    store,
    isRunning,
    stopNode,
    disarmTrigger,
    scrollbackBytes: (id) => sizes.get(id) ?? 0,
    forgetOutput,
    clearSite: (which, origin) =>
      session.fromPartition(which === 'agent' ? AGENT_PARTITION : PERSON_PARTITION).clearStorageData({
        origin,
        storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage']
      })
  })
  const readSizes = async (projectId: string): Promise<void> => {
    const ids = store
      .get()
      .nodes.filter((n) => n.projectId === projectId)
      .map((n) => n.id)
    await Promise.all(ids.map(async (id) => sizes.set(id, (await fileInfo(scrollbackPath(id)))?.size ?? 0)))
  }

  const handle = (name: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(`pb:projects:${name}`, async (_e, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (e) {
        return { ok: false, reason: message(e) }
      }
    })
  }

  const browserBytes = async (): Promise<StorageReport['browser']> => {
    const [personBytes, agentBytes, ...caches] = await Promise.all([
      folderBytes(partitionDir(dataDir, PERSON_PARTITION)),
      folderBytes(partitionDir(dataDir, AGENT_PARTITION)),
      ...BROWSER_PARTITIONS.map((p) => folderBytes(join(partitionDir(dataDir, p), 'Cache'))),
      ...BROWSER_PARTITIONS.map((p) => folderBytes(join(partitionDir(dataDir, p), 'Code Cache')))
    ])
    return {
      personBytes,
      agentBytes,
      cacheBytes: caches.reduce((a, b) => a + b, 0)
    }
  }

  handle('storage', async (): Promise<StorageReport> => ({
    projects: await measureProjects(store.get(), {
      scrollback: (id) => fileInfo(scrollbackPath(id)),
      transcript: fileInfo,
      isRunning,
      now: Date.now()
    }),
    browser: await browserBytes()
  }))
  handle('previewArchive', async (id: string) => {
    await readSizes(String(id))
    return archiver.preview(String(id))
  })
  handle('archive', async (id: string, options: Partial<ArchiveOptions> | undefined) => {
    await readSizes(String(id))
    return archiver.archive(String(id), {
      clearScrollback: options?.clearScrollback === true,
      clearSites: options?.clearSites === true
    })
  })
  handle('clearBrowserCache', async () => {
    const before = (await browserBytes()).cacheBytes
    await Promise.all(
      BROWSER_PARTITIONS.map(async (p) => {
        const ses = session.fromPartition(p)
        await ses.clearCache()
        await ses.clearCodeCaches({})
      })
    )
    const after = (await browserBytes()).cacheBytes
    return { ok: true, freedBytes: Math.max(0, before - after) }
  })
}
