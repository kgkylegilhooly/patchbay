import { ipcMain } from 'electron'
import type { AttemptKey, RemovalCheck, StartComparison } from '../../shared/compare'
import type { CompareService } from './service'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const keyOf = (k: unknown): AttemptKey | null => (k === 'a' || k === 'b' ? k : null)

/** What the page sends back as a confirmation is taken as numbers only, then compared with what is true now. */
function readConfirm(v: unknown): RemovalCheck | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (typeof r.uncommitted !== 'number' || typeof r.unmerged !== 'number' || typeof r.ignored !== 'number' || typeof r.changes !== 'string') return undefined
  return { head: typeof r.head === 'string' ? r.head : null, uncommitted: r.uncommitted, unmerged: r.unmerged, changes: r.changes, ignored: r.ignored }
}

/**
 * Serves `pb:compare:*`, the comparison dialog's and view's channels. See src/preload/compare.ts. `known` says whether
 * the canvas itself names a folder (a project, a worktree group, a session): only those are read or worked from.
 */
export function registerCompareIpc({ service, inspect, known }: { service: CompareService; inspect: (folder: string) => Promise<unknown>; known: (folder: string) => boolean }): void {
  const handle = (name: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(`pb:compare:${name}`, async (_e, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (e) {
        return { ok: false, reason: message(e) }
      }
    })
  }
  const bad = { ok: false, reason: 'No such attempt.' }
  const unknown = { ok: false, reason: "Choose a folder that is on the canvas: the project's folder, a worktree group or an agent's folder." }
  handle('inspect', (folder: string) => (known(String(folder ?? '')) ? inspect(String(folder)) : unknown))
  handle('start', (req: StartComparison) => (known(String(req?.source ?? '')) ? service.start(req) : unknown))
  handle('list', (projectId: string) => service.list(String(projectId)))
  handle('get', (id: string) => service.get(String(id)))
  handle('state', (id: string, k: unknown) => (keyOf(k) ? service.state(String(id), keyOf(k)!) : { ...bad, gone: true }))
  handle('diff', (id: string, k: unknown, path: string, side: string) => (keyOf(k) ? service.diff(String(id), keyOf(k)!, String(path), side === 'committed' ? 'committed' : 'uncommitted') : bad))
  handle('verify', (id: string, k: unknown) => (keyOf(k) ? service.verify(String(id), keyOf(k)!) : bad))
  handle('choose', (id: string, k: unknown) => service.choose(String(id), k === null ? null : keyOf(k) ?? null))
  handle('remove', (id: string, k: unknown, o: { deleteBranch?: unknown; confirm?: unknown }) =>
    keyOf(k) ? service.remove(String(id), keyOf(k)!, { deleteBranch: o?.deleteBranch === true, confirm: readConfirm(o?.confirm) }) : bad
  )
  handle('forget', (id: string) => service.forget(String(id)))
}
