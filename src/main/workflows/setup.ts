import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { CanvasStore, RunResult } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import type { WorkflowRun } from '../../shared/workflow'
import type { Verbs } from '../control/verbs'
import { readRevision } from '../tasks/verification'
import { BUILT_IN_WORKFLOWS } from '../../shared/workflowBuiltins'
import { registerWorkflowIpc } from './ipc'
import { createWorkflowService, type WorkflowServiceDeps } from './service'
import { createRunStore } from './store'
import { withWorkflowVerbs } from './verbs'

/**
 * Workflows: saved processes whose steps Patchbay runs in order. One call from src/main/index.ts; see
 * docs/plans/workflows-impl.md. Returns the verbs wrapper, and `recover`, to call once the host's run results are in.
 */
export function setupWorkflows(d: {
  store: CanvasStore
  runner: { startNode(id: string): Promise<void>; stopNode(id: string): Promise<void>; runs(): Record<string, RunResult>; onRun(cb: (id: string, run: RunResult) => void): void }
  tracker: { get(id: string): AgentStatus; onChange(cb: (id: string, status: AgentStatus) => void): void }
  stops: { holding(id: string): boolean }
  /** Whether the session host has a live session for a node. */
  isRunning(id: string): boolean
  /** Whether an IPC call comes from the app's own page. */
  isAppUi(e: IpcMainInvokeEvent): boolean
  tasks: WorkflowServiceDeps['tasks']
  dataDir: string
  launcher: string
  toplevel(folder: string): Promise<string | null>
  createWorktree(a: { repo: string; branch: string }): Promise<{ path: string; branch: string; repo: string }>
  send(nodeId: string, text: string): { ok: boolean; reason?: string }
  docs: { openFile(path: string, o: { projectId?: string; at?: { x: number; y: number } }): Promise<{ ok: true; nodeId: string; existed: boolean } | { ok: false; reason: string }> }
  broadcast(channel: string, ...args: unknown[]): void
  log(line: string): void
}): { wrap(verbs: Verbs): Verbs; recover(): Promise<void> } {
  const runStore = createRunStore(join(d.dataDir, 'workflow-runs'), { log: d.log })
  const service = createWorkflowService({
    store: d.store,
    runner: d.runner,
    tracker: d.tracker,
    stops: d.stops,
    isRunning: d.isRunning,
    runStore,
    dataDir: d.dataDir,
    launcher: d.launcher,
    toplevel: d.toplevel,
    createWorktree: d.createWorktree,
    tasks: d.tasks,
    send: d.send,
    revision: readRevision,
    builtIn: BUILT_IN_WORKFLOWS,
    log: d.log,
    changed: (run: WorkflowRun) => d.broadcast('pb:workflows:onChange', run),
    async openReader(path, a) {
      const r = await d.docs.openFile(path, { projectId: a.projectId })
      if (!r.ok) {
        d.log(`Workflows: couldn't show ${path} in a reader: ${r.reason}`)
        return null
      }
      if (!r.existed && a.groupId) d.store.dispatch({ op: 'setParent', ids: [r.nodeId], parentId: a.groupId })
      return r.nodeId
    }
  })
  for (const u of service.unavailable) d.log(`Workflows: a run couldn't be loaded (${u.problem})${u.setAside ? `; kept at ${u.setAside}` : ''}.`)
  registerWorkflowIpc({ service, dataDir: d.dataDir, isAppUi: d.isAppUi })
  return { wrap: (verbs) => withWorkflowVerbs(verbs, { store: d.store, service }), recover: () => service.recover() }
}
