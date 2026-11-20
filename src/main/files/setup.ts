import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import { gitEnvFrom } from '../../core/git/args'
import { gitRunner, snapshotTree } from './snapshot'
import type { CanvasStore } from '../../shared/contract'
import { isSessionNode, type AgentStatus } from '../../shared/model'
import { pathKey } from './touched'
import { broadcast } from '../ipc'
import { cleanEnv } from '../sessions/env'
import { createFilesTouched, type FilesTouchedService } from './service'

/**
 * The files each agent session edited. One call from src/main/index.ts; serves `pb:files:*` (src/preload/files.ts)
 * and pushes chip counts on `pb:files:summary`. See docs/plans/files-touched.md.
 */
export function setupFilesTouched(d: {
  store: CanvasStore
  tracker: { get(id: string): AgentStatus; onChange(cb: (id: string, status: AgentStatus) => void): void }
  dataDir: string
  log?: (line: string) => void
}): FilesTouchedService {
  // Snapshot objects live here, not in anyone's repository, and are pruned with it. See snapshot.ts.
  const store = { tmpDir: join(d.dataDir, 'files-touched', 'tmp'), objectDir: join(d.dataDir, 'files-touched', 'objects') }
  mkdirSync(store.tmpDir, { recursive: true })
  const git = gitRunner(gitEnvFrom(cleanEnv(process.env, {})))
  // Which checkout each window's folder is in, looked up again after a while: a folder can become a worktree.
  const tops = new Map<string, { at: number; top: Promise<string | null> }>()
  const toplevel = (cwd: string): Promise<string | null> => {
    const hit = tops.get(cwd)
    if (hit && Date.now() - hit.at < 60_000) return hit.top
    const top = git(cwd, ['rev-parse', '--show-toplevel'], {}).then((r) => (r.code === 0 ? resolve(r.stdout.trim()) : null), () => null)
    tops.set(cwd, { at: Date.now(), top })
    return top
  }
  /** Other live windows, agents or terminals, whose folder is in this same checkout (a worktree inside it is not). */
  const sharing = async (nodeId: string, root: string): Promise<string[]> => {
    const inside = (folder: string): boolean => {
      const rel = relative(root, folder)
      return !rel.startsWith('..') && !isAbsolute(rel)
    }
    const others = d.store.get().nodes.filter((n) => isSessionNode(n) && n.id !== nodeId && !!n.cwd && inside(n.cwd) && d.tracker.get(n.id) !== 'exited')
    const found = await Promise.all(
      others.map(async (n) => {
        const top = await toplevel((n as { cwd: string }).cwd)
        return top && pathKey(top) === pathKey(resolve(root)) ? n.title : null
      })
    )
    return found.filter((t): t is string => t !== null)
  }
  const service = createFilesTouched({
    agents: () => d.store.get().nodes.flatMap((n) => (n.kind === 'claude' ? [{ id: n.id, title: n.title, cwd: n.cwd, transcriptPath: n.transcriptPath }] : [])),
    status: (id) => d.tracker.get(id),
    onStatus: (cb) => d.tracker.onChange(cb),
    snapshot: (cwd) => snapshotTree(git, cwd, store),
    git,
    store,
    file: join(d.dataDir, 'files-touched.json'),
    push: (summary) => broadcast('pb:files:summary', summary),
    log: d.log,
    sharing
  })
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  ipcMain.handle('pb:files:get', (_e, nodeId: unknown) => service.files(text(nodeId)))
  ipcMain.handle('pb:files:diff', (_e, nodeId: unknown, path: unknown, scope: unknown) =>
    service.diff(text(nodeId), text(path), scope === 'session' ? 'session' : 'turn').catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }))
  )
  ipcMain.handle('pb:files:summary', () => service.summary())
  app.on('will-quit', () => {
    service.close()
    void service.flush()
  })
  return service
}
