import { ipcMain } from 'electron'
import type { AttemptKey, RemovalCheck, StartComparison } from '../../shared/compare'
import type { CompareService } from './service'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const keyOf = (k: unknown): AttemptKey | null => (k === 'a' || k === 'b' ? k : null)

/** What the page sends back as a confirmation is taken as numbers only, then compared with what is true now. */
function readConfirm(v: unknown): RemovalCheck | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (typeof r.uncommitted !== 'number' || typeof r.unmerged !== 'number') return undefined
  return { head: typeof r.head === 'string' ? r.head : null, uncommitted: r.uncommitted, unmerged: r.unmerged }
}

/** Serves `pb:compare:*`, the comparison dialog's and view's channels. See src/preload/compare.ts. */
export function registerCompareIpc({ service, inspect }: { service: CompareService; inspect: (folder: string) => Promise<unknown> }): void {
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
  handle('inspect', (folder: string) => inspect(String(folder ?? '')))
  handle('start', (req: StartComparison) => service.start(req))
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
