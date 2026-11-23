import { homedir } from 'node:os'
import { ipcMain, powerMonitor, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { runProgram } from '../core/git/run'
import { tailLines } from '../core/transcript/peek'
import type { CanvasStore } from '../shared/contract'
import { isSessionNode, type TerminalNode } from '../shared/model'
import type { SyncReport } from '../shared/sessionSync'
import { broadcast } from './ipc'
import type { BackgroundHost } from './sessions/backgroundHost'
import type { NodeRunner } from './sessions/nodeRunner'
import { CHECK_EVERY_MS, createSessionSync, pidAlive, type SessionSync, type SyncNodeView } from './sessions/sessionSync'
import type { StatusTracker } from './sessions/statusTracker'
import { ADOPT_SIZE, adoptSpot } from './sessions/adoptSpot'
import { viewSize } from './viewSize'


function taskkillTree(pid: number): Promise<void> {
  // It fails if the process has already gone, which is what was wanted anyway.
  return runProgram('taskkill', ['/pid', String(pid), '/T', '/F'], { env: process.env as Record<string, string>, timeoutMs: 15_000, maxBytes: 64 * 1024 }).then(() => undefined)
}

/**
 * Wires the session check into the app: on a timer, on reconnecting, on waking and when the window gets focus, plus
 * Settings > Background sessions. Serves `pb:sync:*`; see src/preload/sessionSync.ts and docs/plans/session-sync.md.
 */
export function setupSessionSync(deps: {
  store: CanvasStore
  host: BackgroundHost
  runner: NodeRunner
  tracker: StatusTracker
  /** Whether the canvas shows this terminal as ended. */
  terminalShownExited(id: string): boolean
  latestSignal(id: string): number | undefined
  window(): BrowserWindow | null
  isAppUi(e: IpcMainInvokeEvent): boolean
  log?(line: string): void
}): SessionSync {
  const { store, host, runner, tracker } = deps
  const find = (id: string) => store.get().nodes.find((n) => n.id === id)

  const nodes = (): SyncNodeView[] =>
    store
      .get()
      .nodes.filter(isSessionNode)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        shown: n.kind === 'claude' ? tracker.get(n.id) : n.kind === 'terminal' && deps.terminalShownExited(n.id) ? 'exited' : null
      }))

  /** Shows a session again. One the canvas had shown as ended gets the notice that says why it's back. */
  const reattach = (id: string): void => {
    const node = find(id)
    const wasEnded = node?.kind === 'claude' ? tracker.get(id) === 'exited' : node?.kind === 'terminal' && deps.terminalShownExited(id)
    runner.reattachNode(id)
    if (wasEnded && host.isRunning(id)) broadcast('pb:sync:onJoined', id)
  }

  const sync = createSessionSync({
    nodes,
    host,
    reattach,
    transcript: async (id) => {
      const node = find(id)
      return node?.kind === 'claude' && node.transcriptPath ? tailLines(node.transcriptPath) : null
    },
    seed: (id, status) => tracker.seed(id, status),
    since: (id) => tracker.since(id)?.at,
    latestSignal: deps.latestSignal,
    onReport: (report: SyncReport) => broadcast('pb:sync:onReport', report),
    log: deps.log
  })

  host.onOutput((id) => sync.output(id))
  tracker.onChange((id) => sync.heard(id))
  // Running in the host though this app had counted it as ended: shown again, or reported if no node is its own.
  host.onRevive((id) => {
    if (find(id)) reattach(id)
    else void sync.check('a session came back with no node', true)
  })
  let mode = host.info().mode
  host.onInfo((info) => {
    if (info.mode === 'background' && mode !== 'background') void sync.check('reconnected', true)
    mode = info.mode
  })
  powerMonitor.on('resume', () => void sync.check('woke from sleep', true))
  // Looked for again on each tick, as the window may not exist yet, or may be a new one.
  let watched: BrowserWindow | null = null
  const watchFocus = (): void => {
    const win = deps.window()
    if (!win || win === watched || win.isDestroyed()) return
    watched = win
    win.on('focus', () => void sync.check('window focus'))
  }
  watchFocus()
  setInterval(() => {
    watchFocus()
    void sync.check('timer')
  }, CHECK_EVERY_MS).unref()

  const appOnly = <A extends unknown[], R>(fn: (...args: A) => R) => (e: IpcMainInvokeEvent, ...args: A): R => {
    if (!deps.isAppUi(e)) throw new Error('Only the application UI can do this.')
    return fn(...args)
  }
  const orphan = (id: unknown): string => {
    if (typeof id !== 'string' || find(id) || !host.isRunning(id)) throw new Error('That session has a node, or has ended.')
    return id
  }

  ipcMain.handle('pb:sync:report', () => (watchFocus(), sync.report()))
  ipcMain.handle('pb:sync:check', appOnly(() => sync.check('Settings', true)))
  ipcMain.handle(
    'pb:sync:endAndRestart',
    appOnly(async (id: unknown) => {
      if (typeof id !== 'string' || !isSessionNode(find(id))) return
      await runner.endAndRestart(id)
    })
  )
  ipcMain.handle(
    'pb:sync:endOrphan',
    appOnly(async (id: unknown) => {
      const sid = orphan(id)
      const pid = host.pid(sid)
      // Its tree, only while the host still says that pid is this session's and it's there: never a reused pid.
      if (pid !== null && host.isRunning(sid) && host.pid(sid) === pid && pidAlive(pid)) await taskkillTree(pid)
      await host.kill(sid)
      host.forget(sid)
      await sync.check('ended a session with no node', true)
    })
  )
  ipcMain.handle(
    'pb:sync:adoptOrphan',
    appOnly(async (id: unknown) => {
      const sid = orphan(id)
      const doc = store.get()
      // A free spot in view, as new nodes get: never on top of the sessions already there.
      const at = adoptSpot(doc, viewSize())
      const node: TerminalNode = {
        id: sid,
        kind: 'terminal',
        title: 'Recovered session',
        ...at,
        ...ADOPT_SIZE,
        parentId: null,
        ...(doc.activeProjectId ? { projectId: doc.activeProjectId } : {}),
        cwd: homedir()
      }
      store.dispatch({ op: 'addNode', node })
      runner.reattachNode(sid)
      await sync.check('adopted a session with no node', true)
    })
  )
  return sync
}
