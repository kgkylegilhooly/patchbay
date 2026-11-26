import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { readIfPresent, writeAtomic } from '../core/persist/atomicFile'
import type { ScrollbackStore } from '../core/persist/scrollbackStore'
import { readMessagesTailAndMore, readTranscriptAsync, stripAnsi } from '../core/transcript/read'
import { conversationAnswer, conversationLimit, type ConversationAnswer } from '../shared/conversation'
import { checkRemovable, createWorktree, removeWorktree } from '../core/worktree/service'
import type { ApprovalChoice, BrowserStep, CanvasStore, HostInfo, NodeError, PendingApproval, SessionHost } from '../shared/contract'
import { agentOf, isSessionNode, type AgentStatus, type BrowserNode, type CanvasDoc, type CanvasNode, type CanvasOp, type ClaudeNode, type GroupNode, type TerminalNode, type WhiteboardShape } from '../shared/model'
import { placeInProject } from '../core/canvas/place'
import { viewSize } from './viewSize'
import { outputKeptFor } from '../shared/closedShells'
import type { Settings } from '../shared/settings'
import { createActivityLog } from './activity'
import type { LiveBrowserDriver } from './browser/driver'
import { listLaunchConfigs, prepareLaunchRun } from './launchRuns'
import { sshHosts } from '../core/ssh/config'
import { findSsh } from './sessions/ssh'
import type { TriggerService } from './triggers/service'
import type { AfterGate } from './control/after'
import { spotNear } from './control/verbs'
import { mergeSettings, parseSettings, restoreSeed, withTriggersPaused, type ScrollbackSaver } from './lifecycle'
import { nameFromOutput, runToEnd, TITLE_ARGS } from './nameWithAi'
import type { Notifier } from './notifier'
import type { Approvals } from './sessions/approvals'
import { customLaunch } from './sessions/claudeLaunch'
import { cleanEnv } from './sessions/env'
import type { NodeRunner } from './sessions/nodeRunner'
import { openUsageSignIn } from './usage/pageSource'
import type { PortWatcher } from './ports/ports'
import type { UsageSecret } from './usage/usageSecret'
import type { UsageService } from './usage/usageService'
import { sourceConfig, type UsagePoller } from './usage/usageSource'
import type { StatusTracker } from './sessions/statusTracker'
import { readBoardImageAsync, saveBoardImageAsync } from './boardImages'
import { agentOffNow } from './agentsAllowed'
import { openInVsCodeAt } from './openFolder'
import { createRunKeeper } from './runKeeper'
import { createRunSeries } from './runSeries'
import { openTerminalLink, readClosedTranscript, reopenClosed, resolveTerminalPath, savePastedImage, type ResolvedPath } from './shellActions'
import type { Log } from './watchdog'
import type { SendGuard } from './sessions/sendGuard'
import type { SignalWatcher } from './sessions/signals'
import { JOINED_NOTICE, type JoinedRefusal } from '../shared/sessionSync'
import { createOutputPacer } from './outputPacer'
import { onScreenIds } from './onScreen'
import { inSettingsQueue } from './settingsQueue'
import { removeProjectStopped } from './projects/remove'
import { agentProgramProblem } from './sessions/agentProgramCheck'
import { defaultAgentOf } from '../shared/agents'
import { pickOrStub } from './testPickers'

export interface IpcServices {
  dataDir: string
  /** Where hangs, crashes and stalls are noted. See watchdog.ts. */
  log?: Log
  /** Follows resizes, typing and bracketed paste, for text main types into Git Bash. See sessions/sendGuard.ts. */
  sendGuard?: SendGuard
  /** Hooks and status lines that arrive as files. See sessions/signals.ts. */
  signals?: SignalWatcher
  store: CanvasStore
  host: SessionHost
  runner: NodeRunner
  tracker: StatusTracker
  approvals: Approvals
  gate: AfterGate
  scrollback: ScrollbackStore
  saver: ScrollbackSaver
  notifier: Notifier
  testNotification: () => Promise<'shown' | 'failed' | 'unsupported'>
  attention: () => string[]
  usage: UsageService
  usageSecret: UsageSecret
  usagePoller: UsagePoller
  ports: PortWatcher
  browser: LiveBrowserDriver
  hostInfo: () => HostInfo
  /** Exits with this intent, asking first if it needs to. */
  quit: (intent: 'leave-running' | 'stop-all') => void
  stopHost: () => Promise<void>
  resolveOtherHost: (choice: 'stop-it' | 'quit') => Promise<void>
  triggers: TriggerService
  /** The script that runs a launch.json configuration. */
  launchRunner: string
  /** Called after settings.json is saved, for anything that reads it on change rather than on use. */
  onSettingsSaved?: () => void
}

/** The doc with each whiteboard's shapes left out. The window keeps them from onBoardShapes. */
export function withoutShapes(doc: CanvasDoc): CanvasDoc {
  return doc.nodes.some((n) => n.kind === 'whiteboard') ? { ...doc, nodes: doc.nodes.map((n) => (n.kind === 'whiteboard' ? { ...n, shapes: [] } : n)) } : doc
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

const isSession = isSessionNode
const TITLE_MESSAGES = 12
const USAGE_PUSH_MS = 500

/** Serves every `pb:` channel. See src/preload/index.ts for the conventions. */
export function registerIpc(s: IpcServices): { reattached(ids: string[]): void; terminalShownExited(id: string): boolean } {
  const { dataDir, store, host, runner, tracker, approvals, gate, scrollback, saver, notifier, testNotification, attention, usage, usageSecret, usagePoller, ports, hostInfo, quit, stopHost, resolveOtherHost, triggers, launchRunner, onSettingsSaved } = s
  const find = (id: string): CanvasNode | undefined => store.get().nodes.find((n) => n.id === id)

  // Terminals have no hooks, so the only status they can truthfully have is that the process ended.
  const exitedTerminals = new Set<string>()
  const clearExited = (id: string): void => {
    if (host.isRunning(id) && exitedTerminals.delete(id)) broadcast('pb:onStatus', id, null)
  }

  const activity = createActivityLog({ push: (id, at) => broadcast('pb:onActivity', id, at) })

  /**
   * The sessions each window shows, by its webContents. Busy agents in another project's tab sent every byte to the
   * window only for it to be thrown away. A window that hasn't said yet gets everything.
   */
  const watching = new Map<number, Set<string>>()
  /**
   * The nodes of the project on screen. A window keeps another project's terminals warm for a while after a switch,
   * watching them at a slow pace: those count as out of sight, for the host's batching and the pacer alike.
   */
  let onScreen = new Set<string>()
  let seen: { nodes: CanvasDoc['nodes']; active: string } | null = null
  const noteOnScreen = (doc: CanvasDoc): boolean => {
    if (seen && seen.nodes === doc.nodes && seen.active === doc.activeProjectId) return false
    seen = { nodes: doc.nodes, active: doc.activeProjectId }
    const next = onScreenIds(doc)
    const same = next.size === onScreen.size && [...next].every((id) => onScreen.has(id))
    onScreen = next
    return !same
  }
  noteOnScreen(store.get())
  // The host sends what no window shows, or keeps warm out of sight, in bigger, rarer pieces. See sessions/host.ts.
  const tellShown = (): void => {
    if (watching.size === 0) return host.setShown?.(null)
    const all = new Set<string>()
    for (const ids of watching.values()) for (const id of ids) if (onScreen.has(id)) all.add(id)
    host.setShown?.(all)
  }
  store.subscribe((doc) => {
    if (noteOnScreen(doc)) tellShown()
  })
  ipcMain.on('pb:watchOutput', (e, ids: unknown) => {
    if (!Array.isArray(ids)) return
    const contents = e.sender
    const contentsId = contents.id
    if (!watching.has(contentsId)) contents.once('destroyed', () => (watching.delete(contentsId), tellShown()))
    watching.set(contentsId, new Set(ids.filter((x): x is string => typeof x === 'string')))
    tellShown()
  })
  // A window that falls behind is sent no more output until it catches up: sessions out of sight are held first.
  const pacer = createOutputPacer({
    snapshot: (id) => host.snapshot(id),
    wants: (contentsId, id) => watching.get(contentsId)?.has(id) ?? true,
    foreground: (id) => onScreen.has(id)
  })
  const paced = new Set<number>()
  ipcMain.on('pb:outputAck', (e, taken: unknown) => {
    if (typeof taken === 'number') pacer.ack(e.sender, taken)
  })
  const sendOutput = (id: string, data: string, seq: number): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      const contents = win.webContents
      const shown = watching.get(contents.id)
      if (shown && !shown.has(id)) continue
      if (!paced.has(contents.id)) {
        const contentsId = contents.id
        paced.add(contentsId)
        // A reloaded page counts what it takes from nothing again.
        const restart = (): void => pacer.forget(contentsId)
        contents.on('did-navigate', restart)
        contents.once('destroyed', () => (restart(), paced.delete(contentsId)))
      }
      pacer.deliver(contents, id, data, seq)
    }
  }

  host.onOutput((id, data, seq) => {
    s.sendGuard?.output(id, data)
    sendOutput(id, data, seq)
    const kind = find(id)?.kind
    if (kind === 'terminal' || kind === 'run') saver.markDirty(id)
    // An idle Claude still redraws, as when its window is resized, and that isn't it doing anything.
    if (kind === 'terminal' || kind === 'run' || tracker.get(id) === 'working') activity.note(id, false)
  })
  host.onExit((id) => {
    activity.note(id, true)
    if (find(id)?.kind !== 'terminal') return
    exitedTerminals.add(id)
    broadcast('pb:onStatus', id, 'exited')
  })
  tracker.onChange((id, status: AgentStatus) => {
    activity.note(id, true)
    broadcast('pb:onStatus', id, status)
  })
  runner.onError((id, error: NodeError | null) => broadcast('pb:onNodeError', id, error))
  approvals.onChange((pending: PendingApproval[]) => broadcast('pb:onApprovals', pending))
  // A busy whiteboard can hold megabytes of strokes, and copying them to the window with every change anywhere made
  // the whole canvas lag. So a board's shapes go only when they change, and the doc carries its boards without them.
  const sentShapes = new Map<string, WhiteboardShape[]>()
  store.subscribe((doc) => {
    const boards = new Set<string>()
    for (const n of doc.nodes) {
      if (n.kind !== 'whiteboard') continue
      boards.add(n.id)
      if (sentShapes.get(n.id) === n.shapes) continue
      sentShapes.set(n.id, n.shapes)
      broadcast('pb:onBoardShapes', n.id, n.shapes)
    }
    for (const id of sentShapes.keys()) if (!boards.has(id)) sentShapes.delete(id)
    broadcast('pb:onDoc', withoutShapes(doc))
  })

  /** A new terminal with no folder means the worktree of its group, or else the home folder. */
  const withDefaultFolder = (op: CanvasOp): CanvasOp => {
    if (op.op !== 'addNode' || !isSession(op.node) || op.node.cwd) return op
    const parent = op.node.parentId ? (find(op.node.parentId) as GroupNode | undefined) : undefined
    const doc = store.get()
    const projectFolder = doc.projects.find((p) => p.id === doc.activeProjectId)?.folder
    return { ...op, node: { ...op.node, cwd: parent?.worktree?.path ?? (projectFolder || homedir()) } }
  }

  /** Stopping first lets a node with no conversation forget its session before it could enter history. */
  const stopSessions = async (ids: string[]): Promise<void> => {
    const closing = ids.filter((id) => isSession(find(id)))
    await Promise.all(closing.map((id) => runner.stopNode(id)))
    for (const id of closing) {
      // A terminal's or run's output is kept for Reopen (F48): its last screen goes to disk before the host forgets it.
      // An empty one is left alone, as the file may be all there is from a launch it never started in.
      const kind = find(id)?.kind
      const keep = kind === 'terminal' || kind === 'run'
      const last = keep ? host.snapshot(id).data : ''
      if (last) void scrollback.write(id, last).catch((e: unknown) => console.error('Patchbay could not save scrollback:', e))
      approvals.clearNode(id)
      series.forget(id)
      exitedTerminals.delete(id)
      saver.forget(id)
      s.sendGuard?.forget(id)
      s.signals?.forget(id)
      host.forget?.(id)
      usage.forget(id)
      activity.forget(id)
      if (!keep) void scrollback.remove(id).catch((e: unknown) => console.error('Patchbay could not remove scrollback:', e))
    }
  }
  // A terminal's or run's saved output goes once it's neither on the canvas nor in the closed list: forgotten, past the
  // newest 20, or in a project that was deleted (F48).
  let outputKept = outputKeptFor(store.get())
  store.subscribe(() => {
    const now = outputKeptFor(store.get())
    for (const id of outputKept) if (!now.has(id)) void scrollback.remove(id).catch((e: unknown) => console.error('Patchbay could not remove scrollback:', e))
    outputKept = now
  })

  ipcMain.handle('pb:getDoc', () => store.get())
  ipcMain.handle('pb:dispatch', async (_e, op: CanvasOp) => {
    // Arming goes through armTrigger, which checks what was shown. The page can't set a trigger's state itself.
    // Archiving stops the project's sessions first, so it goes through pb:projects:archive. See src/main/projects.
    if (op.op === 'setTriggerState' || op.op === 'setTasks' || op.op === 'archiveProject') return
    // The last project stays, so its sessions must too. So does the last one that isn't archived. See projects/remove.ts.
    if (op.op === 'removeProject') return removeProjectStopped({ store, stopSessions, isRunning: (id) => host.isRunning(id), stopNode: (id) => runner.stopNode(id) }, op.id, Date.now())
    if (op.op !== 'removeNodes') return store.dispatch(withDefaultFolder(op))
    await stopSessions(op.ids)
    store.dispatch({ ...op, at: Date.now() })
  })

  ipcMain.handle('pb:getStatuses', () => {
    const statuses: Record<string, AgentStatus> = { ...tracker.all() }
    for (const id of exitedTerminals) statuses[id] = 'exited'
    return statuses
  })
  ipcMain.handle('pb:getErrors', () => runner.errors())
  ipcMain.handle('pb:attach', async (_e, id: string) => {
    const snapshot = host.snapshot(id)
    // A run node doesn't start on launch, so until it does this is the only way to show its last output.
    if (!snapshot.data && find(id)?.kind === 'run') return { data: (await scrollback.readAsync(id)) ?? '', seq: snapshot.seq }
    return snapshot
  })

  ipcMain.on('pb:input', (_e, id: string, data: string) => {
    runner.noteInput(id, data)
    s.sendGuard?.typed(id, data)
    host.write(id, data)
  })
  ipcMain.on('pb:resize', (_e, id: string, cols: number, rows: number) => {
    s.sendGuard?.resized(id)
    host.resize(id, cols, rows)
  })
  ipcMain.on('pb:noteFocus', (_e, id: string | null) => notifier.setFocusedNode(id))

  /**
   * A launch.json run is read again on each click, so it runs what the file says now, or says why it can't. A plan not
   * agreed to yet, or changed since, asks first, and `accept` is the person's answer (LJ1, see launchRuns.ts).
   */
  const prepareRun = async (id: string, accept?: string): Promise<{ ok: false; reason: string; approvePlan?: string } | null> => {
    const node = find(id)
    if (node?.kind !== 'run' || !node.launch) return null
    const ready = await prepareLaunchRun(node.launch, { planFile: join(dataDir, 'launch', `${id}.json`), launcher: launchRunner }, accept)
    if (!ready.ok) return ready
    if (ready.command !== node.command || ready.cwd !== node.cwd || ready.approved !== node.launch.approved) {
      store.dispatch({ op: 'patchNode', id, patch: { command: ready.command, cwd: ready.cwd, launch: { ...node.launch, approved: ready.approved } } })
    }
    return null
  }

  ipcMain.handle('pb:startNode', async (_e, id: string) => {
    const node = find(id)
    // A held node goes through the gate, or it'd launch while still listed as held.
    if (node?.kind === 'claude' && node.after.length > 0) return gate.startNow(id)
    const refused = await prepareRun(id)
    if (refused) return refused
    await runner.startNode(id)
    clearExited(id)
  })
  const restartNodeNow = async (id: string, opts?: { shownExited?: unknown; pastMemory?: unknown; acceptPlan?: unknown }) => {
    // Settings > Agents: refused as a notice the window can dismiss. A session still running keeps running.
    const agent = find(id)
    const off = agent?.kind === 'claude' ? agentOffNow(agentOf(agent)) : null
    if (off) return { ok: false as const, reason: off }
    const refused = await prepareRun(id, typeof opts?.acceptPlan === 'string' ? opts.acceptPlan : undefined)
    if (refused) return refused
    const node = find(id)
    if (node?.kind === 'run' && !host.isRunning(id) && !host.snapshot(id).data) {
      await runner.startNode(id, { initialScrollback: (await scrollback.readAsync(id)) ?? undefined })
      return
    }
    // A terminal that never started this launch, such as one whose folder was missing, still has its
    // saved scrollback on disk. Restarting without it would let the next save overwrite that file.
    if (node?.kind === 'terminal' && !host.isRunning(id) && !host.snapshot(id).data) {
      await runner.startNode(id, { initialScrollback: restoreSeed('terminal', await scrollback.readAsync(id)) })
    } else if ((await runner.restartOrJoin(id, { shownExited: opts?.shownExited === true, pastMemory: opts?.pastMemory === true })) === 'joined') {
      // It was still running unseen, so it's shown again: the notice offers ending it first. See docs/plans/session-sync.md.
      clearExited(id)
      return { ok: false, reason: JOINED_NOTICE, joined: true } satisfies JoinedRefusal
    }
    clearExited(id)
  }
  ipcMain.handle('pb:restartNode', (_e, id: string, opts?: { shownExited?: unknown; pastMemory?: unknown; acceptPlan?: unknown }) => restartNodeNow(id, opts))

  ipcMain.handle('pb:createWorktree', async (_e, groupId: string, a: { repo: string; branch: string }) => {
    const group = find(groupId)
    if (group?.kind !== 'group') throw new Error('That group no longer exists.')
    if (group.worktree) throw new Error('This group already has a worktree.')
    const worktree = await createWorktree(a)
    store.dispatch({ op: 'patchNode', id: groupId, patch: { worktree } as Partial<CanvasNode> })
  })
  ipcMain.handle('pb:removeWorktree', async (_e, groupId: string) => {
    const group = find(groupId)
    if (group?.kind !== 'group' || !group.worktree) return { ok: false, reason: 'This group has no worktree.' }
    const worktree = group.worktree
    // Checked first, so sessions aren't stopped for a removal that will be refused anyway.
    const removable = await checkRemovable(worktree)
    if (!removable.ok) return removable
    // Windows won't delete a folder that a running process has open.
    const inside = store.get().nodes.filter((n) => {
      if (!isSession(n)) return false
      const rel = relative(worktree.path, n.cwd)
      return !rel.startsWith('..') && !isAbsolute(rel)
    })
    await Promise.all(inside.map((n) => runner.stopNode(n.id)))
    const result = await removeWorktree(worktree)
    if (result.ok) store.dispatch({ op: 'patchNode', id: groupId, patch: { worktree: null } as Partial<CanvasNode> })
    return result
  })
  ipcMain.handle('pb:unbindWorktree', (_e, groupId: string) => {
    store.dispatch({ op: 'patchNode', id: groupId, patch: { worktree: null } as Partial<CanvasNode> })
  })
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  // Creating it first, with no settings set, so there's always something to open.
  ipcMain.handle('pb:openSettingsFile', async () => {
    if (!existsSync(settingsFile)) {
      writeFileSync(settingsFile, JSON.stringify({ shell: '', permissionMode: '', claudeTerminal: '', claudeCommand: '' }, null, 2) + '\n')
    }
    await shell.openPath(settingsFile)
  })
  ipcMain.handle('pb:quitApp', () => quit('leave-running'))
  ipcMain.handle('pb:stopAllAndQuit', () => quit('stop-all'))
  ipcMain.handle('pb:getHostInfo', () => hostInfo())
  ipcMain.handle('pb:stopHost', () => stopHost())
  ipcMain.handle('pb:resolveOtherHost', (_e, choice: 'stop-it' | 'quit') => resolveOtherHost(choice))
  ipcMain.handle('pb:testNotification', () => testNotification())
  ipcMain.handle('pb:getAttention', () => attention())
  ipcMain.handle('pb:getRuns', () => runner.runs())
  ipcMain.handle('pb:stopRun', (_e, id: string) => runner.stopTree(id))
  // Restart when it stops (F50): a crash of a run with it on is started again, rather than announced as a failure.
  const keeper = createRunKeeper({
    keep: (id) => { const n = find(id); return n?.kind === 'run' && n.keepRunning === true },
    running: (id) => host.isRunning(id),
    // Never with an answer: a launch.json changed since it was agreed to waits for the person, and they're told (LJ1).
    restart: async (id) => {
      const r = await restartNodeNow(id)
      if (r && 'approvePlan' in r) notifier.runNotRestarted(id, 'Stopped, and not started again: launch.json changed what it runs. Restart it to see the new command.')
    },
    gaveUp: (id) => notifier.runGaveUp(id)
  })
  // Run N times (F64): while a series lasts it owns the run's ends, so neither the keeper nor a failure notice acts on them.
  const series = createRunSeries({
    restart: (id) => restartNodeNow(id),
    running: (id) => host.isRunning(id),
    changed: (id, state) => broadcast('pb:onRunSeries', id, state),
    finished: (id, text) => notifier.runSeriesDone(id, text)
  })
  ipcMain.handle('pb:runSeries:start', (_e, id: unknown, times: unknown) =>
    typeof id === 'string' && find(id)?.kind === 'run' ? series.start(id, Number(times)) : { ok: false, reason: 'Only a run command can run several times.' }
  )
  runner.onRun((id, run) => {
    broadcast('pb:onRun', id, run)
    if (series.onRun(id, run)) return
    const kept = keeper.onRun(id, run)
    if (kept === 'none' && !run.running && !run.stoppedByYou && run.exitCode) notifier.runFailed(id)
  })
  ipcMain.handle('pb:getPorts', () => ports.current())
  ports.onChange(() => broadcast('pb:onPorts', ports.current()))
  // Checked here, so a page can only ever open a port a session is really serving, and only on this PC.
  ipcMain.handle('pb:openPort', async (_e, nodeId: string, port: number) => {
    if (!ports.canOpen(nodeId, port)) return false
    await shell.openExternal(`http://localhost:${port}`)
    return true
  })
  // A person choosing this at the canvas, so it's theirs: no agent can drive it until they link one.
  ipcMain.handle('pb:openPortInBrowser', (_e, nodeId: string, port: number) => {
    const source = find(nodeId)
    if (!source || !s.ports.canOpen(nodeId, port)) return false
    const size = { width: 760, height: 560 }
    const node: BrowserNode = {
      ...size,
      ...spotNear(store.get(), source, size),
      id: randomUUID(),
      kind: 'browser',
      title: `localhost:${port}`,
      url: `http://localhost:${port}/`,
      parentId: null
    }
    if (source.projectId) node.projectId = source.projectId
    store.dispatch({ op: 'addNode', node })
    return true
  })
  ipcMain.handle('pb:browserAttached', (e, nodeId: string, contentsId: number) => s.browser.attach(nodeId, contentsId, e.sender))
  ipcMain.handle('pb:browserNavigate', (_e, nodeId: string, address: string) => s.browser.addressBar(nodeId, address))
  ipcMain.handle('pb:browserStep', (_e, nodeId: string, step: BrowserStep) => s.browser.ownerStep(nodeId, step))
  // Design mode is the person's own picking, so it isn't held back by Take control.
  ipcMain.handle('pb:browserPick', async (_e, nodeId: string) => {
    try {
      return { ok: true, pick: await s.browser.pick(nodeId) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  })
  ipcMain.handle('pb:browserCancelPick', (_e, nodeId: string) => s.browser.cancelPick(nodeId).catch(() => {}))
  ipcMain.handle('pb:getBrowserStates', () => s.browser.states())
  ipcMain.handle('pb:browserEvidenceImage', (_e, id: string, attempt: string, index: number) => s.browser.evidence?.image(id, attempt, index) ?? null)
  ipcMain.handle('pb:browserEvidence', (_e, id: string) => s.browser.evidence?.list(id) ?? [])
  ipcMain.handle('pb:getUsage', () => usage.state())
  // Every agent's status line reports as it works, many times a second across a busy canvas, and each report redraws
  // whatever shows usage. The window gets the latest at most this often.
  let usageTimer: ReturnType<typeof setTimeout> | null = null
  usage.onChange(() => {
    usageTimer ??= setTimeout(() => {
      usageTimer = null
      broadcast('pb:onUsage', usage.state())
    }, USAGE_PUSH_MS)
  })
  ipcMain.handle('pb:testUsageSource', async () => (await usagePoller.refreshNow()) ?? { ok: false, problem: 'Choose an endpoint or page first.' })
  ipcMain.handle('pb:hasUsageSecret', () => usageSecret.has())
  ipcMain.handle('pb:setUsageSecret', async (_e, header: string) => usageSecret.save(header, parseSettings(await readIfPresent(settingsFile)).usageUrl ?? ''))
  ipcMain.handle('pb:removeUsageSecret', () => usageSecret.remove())
  ipcMain.handle('pb:openUsageSignIn', async () => openUsageSignIn(parseSettings(await readIfPresent(settingsFile)).usageUrl ?? ''))
  ipcMain.on('pb:markSeen', (_e, id: string) => notifier.markSeen(id))
  ipcMain.handle('pb:openDataFolder', async () => {
    await shell.openPath(dataDir)
  })
  ipcMain.handle('pb:writeClipboard', (_e, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.handle('pb:openLog', async () => {
    if (!s.log) return
    await s.log.flush()
    // The log is made by the first line written, which is at startup, so it's there to open.
    await shell.openPath(s.log.file)
  })
  // The window noting a task that held it up for seconds: the person saw it freeze, so it's worth a line.
  ipcMain.on('pb:noteSlow', (_e, ms: unknown, what: unknown) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return
    s.log?.write(`The window was busy for ${(ms / 1000).toFixed(1)} s${typeof what === 'string' && what ? ` (${what.slice(0, 120)})` : ''}.`)
  })
  ipcMain.handle('pb:getAppInfo', () => ({ version: app.getVersion(), dataDir }))
  ipcMain.handle('pb:getSettings', async () => parseSettings(await readIfPresent(settingsFile)))
  ipcMain.handle('pb:agentProgramProblem', async (_e, kind: unknown) => {
    const settings = parseSettings(await readIfPresent(settingsFile))
    return agentProgramProblem(kind === 'codex' || kind === 'claude' ? kind : defaultAgentOf(settings), settings)
  })
  ipcMain.handle('pb:saveSettings', async (_e, next: Settings) => {
    // One read-merge-write at a time, so a save from another page can't undo this one. See settingsQueue.ts.
    const text = await inSettingsQueue(async () => {
      const merged = mergeSettings(await readIfPresent(settingsFile), next)
      if (merged !== null) await writeAtomic(settingsFile, merged)
      return merged
    })
    if (text === null) return { ok: false, reason: 'settings.json has a mistake in it, so saving would overwrite it. Fix it with Open file, under About, then try again.' }
    // A half-typed address is never fetched: reads only happen on the timer or on Test now, once one is set.
    const saved = parseSettings(text)
    usage.setOff(saved.usageSource === 'off')
    if (!sourceConfig(saved)) void usagePoller.refreshNow()
    onSettingsSaved?.()
    return { ok: true }
  })
  // Its own save, not the whole settings: the Work menu has no copy of the rest to send back.
  ipcMain.handle('pb:setTriggersPaused', async (_e, on: unknown) => {
    const text = await inSettingsQueue(async () => {
      const next = withTriggersPaused(await readIfPresent(settingsFile), on === true)
      if (next !== null) await writeAtomic(settingsFile, next)
      return next
    })
    if (text === null) return { ok: false, reason: 'settings.json has a mistake in it, so saving would overwrite it. Fix it with Open file, under About, then try again.' }
    return { ok: true }
  })
  // Never opened by an off-screen test run: see testPickers.ts.
  // Modal to the window that asked, so it can't be asked for twice while one is open.
  const openDialog = (e: Electron.IpcMainInvokeEvent, options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
  }
  ipcMain.handle('pb:pickProgram', (e) =>
    pickOrStub('file', async () => {
      const r = await openDialog(e, { properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }] })
      return r.canceled ? null : r.filePaths[0]
    })
  )
  ipcMain.handle('pb:pickFolder', (e) =>
    pickOrStub('folder', async () => {
      const r = await openDialog(e, { properties: ['openDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    })
  )

  // The only way to arm a trigger. The control server has no route to the trigger service.
  ipcMain.handle('pb:armTrigger', (_e, id: string, shownSpec: string) => triggers.arm(id, shownSpec))
  ipcMain.handle('pb:disarmTrigger', (_e, id: string) => triggers.disarm(id))
  // Takes no prompt: what it sends is what's saved on the trigger.
  ipcMain.handle('pb:runTriggerNow', (_e, id: string) => triggers.runNow(id))
  ipcMain.handle('pb:readLaunchConfigs', (_e, folder: string) => listLaunchConfigs(folder))
  // PATCHBAY_SSH_CONFIG lets a test give its own file in place of the person's.
  ipcMain.handle('pb:listSshHosts', async () => {
    const config = process.env.PATCHBAY_SSH_CONFIG || join(homedir(), '.ssh', 'config')
    return { hosts: sshHosts((await readIfPresent(config)) ?? ''), home: homedir(), installed: findSsh() !== null }
  })

  ipcMain.handle('pb:getApprovals', () => approvals.pending())
  // The only caller of approvals.answer. The control server has no route to it.
  ipcMain.handle('pb:answerApproval', (_e, requestId: string, choice: ApprovalChoice) => {
    approvals.answer(requestId, choice)
  })

  ipcMain.handle('pb:savePastedImage', (_e, bytes: Uint8Array, mime: string) => savePastedImage(dataDir, bytes, mime))
  ipcMain.handle('pb:saveBoardImage', (_e, bytes: Uint8Array, mime: string) => saveBoardImageAsync(join(dataDir, 'whiteboards', 'images'), bytes, mime))
  ipcMain.handle('pb:readBoardImage', (_e, file: string) => readBoardImageAsync(join(dataDir, 'whiteboards', 'images'), file))
  ipcMain.handle('pb:openTerminalLink', (_e, nodeId: string, target: string) => {
    const node = find(nodeId)
    const cwd = isSession(node) ? node.cwd : homedir()
    return openTerminalLink(cwd, target, {
      exists: existsSync,
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      reveal: (path) => shell.showItemInFolder(path),
      openAt: (path, line, column) => openInVsCodeAt(path, line, column)
    })
  })
  const resolvePath = (nodeId: string, target: string): ResolvedPath => {
    const node = find(nodeId)
    return resolveTerminalPath(isSession(node) ? node.cwd : homedir(), target, {
      isDirectory: (path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return null
        }
      }
    })
  }
  ipcMain.handle('pb:resolveTerminalPath', (_e, nodeId: string, target: string) => resolvePath(nodeId, target))
  ipcMain.handle('pb:revealTerminalPath', (_e, nodeId: string, target: string) => {
    const r = resolvePath(nodeId, target)
    if (r.ok) shell.showItemInFolder(r.path)
    return r.ok ? { ok: true } : r
  })

  // Reopen a closed terminal or run (F48): the same node, placed in view, started with its saved output shown above.
  ipcMain.handle('pb:reopenShell', async (_e, id: unknown) => {
    const entry = typeof id === 'string' ? store.get().closedShells?.find((s) => s.node.id === id) : undefined
    if (!entry) return
    // Read before the entry goes, as its file goes with it. Started under a new id: the old session's exit can still be
    // on its way, and an event for the old id must not mark the new window exited.
    const saved = await scrollback.readAsync(entry.node.id).catch(() => null)
    const doc = store.get()
    const { x, y } = placeInProject(doc, doc.activeProjectId, { width: entry.node.width, height: entry.node.height }, viewSize())
    const node = { ...entry.node, id: randomUUID(), x, y, parentId: null, projectId: doc.activeProjectId }
    // The output goes under the new id, so it's kept and shown as any window's is.
    if (saved) await scrollback.write(node.id, saved).catch(() => {})
    store.dispatch({ op: 'addNode', node })
    store.dispatch({ op: 'forgetClosedShell', id: entry.node.id })
    // A run never starts by itself: it's back with its output, for Run. A terminal is a fresh shell in its folder, as
    // after a restart: a command it was opened with (a deploy, say) doesn't run again.
    if (node.kind === 'terminal') await runner.startNode(node.id, { initialScrollback: restoreSeed('terminal', saved), restored: true })
  })
  ipcMain.handle('pb:reopenClosed', async (_e, closedId: string) => {
    // Settings > Agents: an agent turned off isn't reopened, and its entry stays in the list for later.
    const entry = store.get().closed.find((c) => c.id === closedId)
    if (entry && agentOffNow(entry.agent ?? 'claude')) return
    const id = reopenClosed(store, closedId, randomUUID())
    if (id) await runner.startNode(id)
  })
  // The chat view of an agent window. Read again as the conversation grows, so only the newest part is sent.
  ipcMain.handle('pb:readConversation', async (_e, nodeId: string, limit?: number, since?: string): Promise<ConversationAnswer> => {
    const node = find(nodeId)
    if (node?.kind !== 'claude') return { ok: false, reason: 'Only an agent window has a conversation.' }
    if (!node.transcriptPath) return { ok: true, messages: [], earlier: false, version: '' }
    try {
      const count = conversationLimit(limit)
      return conversationAnswer(await readMessagesTailAndMore(node.transcriptPath, count), node.transcriptPath, count, since)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, messages: [], earlier: false, version: '' }
      return { ok: false, reason: `The conversation couldn't be read: ${(e as Error).message}` }
    }
  })
  ipcMain.handle('pb:readClosedTranscript', (_e, closedId: string) => readClosedTranscript(store.get(), closedId))

  ipcMain.handle('pb:getActivity', () => activity.all())

  /** A Claude node's own conversation reads far better than its full-screen output, when there is one yet. */
  const titleMaterial = async (node: TerminalNode | ClaudeNode): Promise<string> => {
    const raw = stripAnsi(host.snapshot(node.id).data)
    if (node.kind !== 'claude' || !node.transcriptPath) return raw
    try {
      return (await readTranscriptAsync(node.transcriptPath, TITLE_MESSAGES)) || raw
    } catch {
      return raw
    }
  }
  ipcMain.handle('pb:nameWithAi', async (_e, id: string) => {
    const node = find(id)
    if (node?.kind !== 'terminal' && node?.kind !== 'claude') return { ok: false, reason: 'Only a terminal or Claude window can be named from its output.' }
    // An empty folder of its own, so the run picks up no project's settings or CLAUDE.md.
    const neutral = join(dataDir, 'naming')
    mkdirSync(neutral, { recursive: true })
    const settings = parseSettings(await readIfPresent(settingsFile))
    return nameFromOutput(await titleMaterial(node), (stdin) => {
      const program = customLaunch({ terminal: settings.claudeTerminal, command: settings.claudeCommand }, TITLE_ARGS)
      return runToEnd(program, stdin, { cwd: neutral, env: cleanEnv(process.env, {}) })
    })
  })

  return {
    reattached(ids) {
      for (const id of ids) clearExited(id)
      broadcast('pb:onReattach', ids)
    },
    terminalShownExited: (id) => exitedTerminals.has(id)
  }
}
