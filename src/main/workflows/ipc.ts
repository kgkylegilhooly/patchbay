import { mkdirSync } from 'node:fs'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { ipcMain, shell } from 'electron'
import type { PersonAction } from '../../shared/workflowBridge'
import type { WorkflowService } from './service'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const inside = (folder: string, p: string): boolean => {
  const rel = relative(folder, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const ACTIONS = ['decide', 'retry', 'stop', 'remind', 'mark-done']

/**
 * Serves `pb:workflows:*`, the workflow picker's, form's, run panel's and editor's channels. See
 * src/preload/workflows.ts. These are the person's own: only the app's page calls them.
 */
export function registerWorkflowIpc({ service, dataDir }: { service: WorkflowService; dataDir: string }): void {
  const handle = (name: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(`pb:workflows:${name}`, async (_e, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (e) {
        return { ok: false, reason: message(e) }
      }
    })
  }
  handle('list', (projectId: string) => service.list(String(projectId)))
  handle('preview', async (a: { projectId: string; ref: string; inputs: Record<string, unknown> }) => {
    const { entries } = await service.list(String(a?.projectId))
    const entry = entries.find((e) => e.ref === a?.ref)
    if (!entry?.workflow) return { ok: false, reason: entry?.problem ?? "That workflow isn't there any more." }
    return { ok: true, steps: service.preview(entry.workflow, a?.inputs ?? {}) }
  })
  handle('start', async (a: { projectId: string; ref: string; hash?: string; inputs: Record<string, unknown>; at?: { x: number; y: number } }) => {
    const at = a?.at && Number.isFinite(a.at.x) && Number.isFinite(a.at.y) ? { x: a.at.x, y: a.at.y } : undefined
    const r = await service.start({
      projectId: String(a?.projectId), ref: String(a?.ref), ...(typeof a?.hash === 'string' ? { hash: a.hash } : {}),
      inputs: a?.inputs && typeof a.inputs === 'object' ? a.inputs : {}, by: { person: true }, ...(at ? { at } : {})
    })
    return r.ok ? { ok: true, runId: r.run.id, groupId: r.run.groupId } : r
  })
  handle('runs', (projectId: string) => service.runs(String(projectId)))
  handle('act', async (runId: string, action: PersonAction) => {
    if (!action || !ACTIONS.includes(action.type)) return { ok: false, reason: 'Unknown action.' }
    const r = await service.act(String(runId), action)
    return r.ok ? { ok: true } : { ok: false, reason: r.message }
  })
  handle('save', (a: { projectId: string; workflow: unknown; where: string; overwrite?: boolean; file?: string }) =>
    service.save({ projectId: String(a?.projectId), workflow: a?.workflow, where: a?.where === 'repository' ? 'repository' : 'personal', overwrite: a?.overwrite === true, ...(typeof a?.file === 'string' ? { file: a.file } : {}) }))
  handle('openFolder', async (projectId: string, where: string) => {
    const dir = await service.folderFor(String(projectId), where === 'repository' ? 'repository' : 'personal')
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })
  // Only files workflows own: definitions in the library folders, and what runs kept.
  handle('openFile', async (path: string) => {
    const p = resolve(String(path))
    const listed = service.runs().some((r) => r.attempts.some((a) => Object.values(a.outputs ?? {}).some((o) => o.type === 'file' && resolve(o.path) === p)))
    const owned = inside(join(dataDir, 'workflows'), p) || inside(join(dataDir, 'workflow-artifacts'), p) || listed || /[\\/]\.patchbay[\\/]workflows[\\/][^\\/]+\.json$/i.test(p)
    if (!owned) return { ok: false, reason: "That isn't a workflow's file." }
    const err = await shell.openPath(p)
    return err ? { ok: false, reason: err } : { ok: true }
  })
}
