import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { readIfPresentSync, writeAtomic } from '../core/persist/atomicFile'
import type { ScrollbackStore } from '../core/persist/scrollbackStore'
import { readMessagesTail, readTranscriptAsync, stripAnsi } from '../core/transcript/read'
import { checkRemovable, createWorktree, removeWorktree } from '../core/worktree/service'
import type { BrowserStep, CanvasStore, HostInfo, NodeError, PendingApproval, SessionHost } from '../shared/contract'
import { isSessionNode, type AgentStatus, type BrowserNode, type CanvasDoc, type CanvasNode, type CanvasOp, type ClaudeNode, type GroupNode, type TerminalNode, type WhiteboardShape } from '../shared/model'
import type { Settings } from '../shared/settings'
import { createActivityLog } from './activity'
import type { LiveBrowserDriver } from './browser/driver'
import { listLaunchConfigs, prepareLaunchRun } from './launchRuns'
import { sshHosts } from '../core/ssh/config'
import { findSsh } from './sessions/ssh'
import type { TriggerService } from './triggers/service'
import type { AfterGate } from './control/after'
import { spotNear } from './control/verbs'
import { mergeSettings, parseSettings, restoreSeed, type ScrollbackSaver } from './lifecycle'
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
import { readBoardImage, saveBoardImage } from './boardImages'
import { openTerminalLink, readClosedTranscript, reopenClosed, resolveTerminalPath, savePastedImage, type ResolvedPath } from './shellActions'
import type { Log } from './watchdog'
import type { SendGuard } from './sessions/sendGuard'
import type { SignalWatcher } from './sessions/signals'

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
/** How much of a conversation the chat view shows. Older messages are in the transcript, and the terminal. */
const CONVERSATION_MESSAGES = 200

/** Serves every `pb:` channel. See src/preload/index.ts for the conventions. */
export function registerIpc(s: IpcServices): { reattached(ids: string[]): void } {
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
  ipcMain.on('pb:watchOutput', (e, ids: unknown) => {
    if (!Array.isArray(ids)) return
    const contents = e.sender
    if (!watching.has(contents.id)) contents.once('destroyed', () => watching.delete(contents.id))
    watching.set(contents.id, new Set(ids.filter((x): x is string => typeof x === 'string')))
  })
  const sendOutput = (id: string, data: string, seq: number): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      const shown = watching.get(win.webContents.id)
      if (!shown || shown.has(id)) win.webContents.send('pb:onOutput', id, data, seq)
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
      approvals.clearNode(id)
      exitedTerminals.delete(id)
      saver.forget(id)
      s.sendGuard?.forget(id)
      s.signals?.forget(id)
      host.forget?.(id)
      usage.forget(id)
      activity.forget(id)
      void scrollback.remove(id).catch((e: unknown) => console.error('Patchbay could not remove scrollback:', e))
    }
  }

  ipcMain.handle('pb:getDoc', () => store.get())
  ipcMain.handle('pb:dispatch', async (_e, op: CanvasOp) => {
    // Arming goes through armTrigger, which checks what was shown. The page can't set a trigger's state itself.
    if (op.op === 'setTriggerState') return
    if (op.op === 'removeProject') {
      // The last project stays, so its sessions must too.
      if (store.get().projects.length < 2) return
      await stopSessions(store.get().nodes.filter((n) => n.projectId === op.id).map((n) => n.id))
      return store.dispatch({ ...op, at: Date.now() })
    }
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
  ipcMain.handle('pb:attach', (_e, id: string) => {
    const snapshot = host.snapshot(id)
    // A run node doesn't start on launch, so until it does this is the only way to show its last output.
    if (!snapshot.data && find(id)?.kind === 'run') return { data: scrollback.read(id) ?? '', seq: snapshot.seq }
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

  /** A launch.json run is read again on each click, so it runs what the file says now, or says why it can't. */
  const prepareRun = async (id: string): Promise<{ ok: false; reason: string } | null> => {
    const node = find(id)
    if (node?.kind !== 'run' || !node.launch) return null
    const ready = await prepareLaunchRun(node.launch, { planFile: join(dataDir, 'launch', `${id}.json`), launcher: launchRunner })
    if (!ready.ok) return ready
    if (ready.command !== node.command || ready.cwd !== node.cwd) store.dispatch({ op: 'patchNode', id, patch: { command: ready.command, cwd: ready.cwd } })
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
  ipcMain.handle('pb:restartNode', async (_e, id: string) => {
    const refused = await prepareRun(id)
    if (refused) return refused
    const node = find(id)
    if (node?.kind === 'run' && !host.isRunning(id) && !host.snapshot(id).data) {
      await runner.startNode(id, { initialScrollback: scrollback.read(id) ?? undefined })
      return
    }
    // A terminal that never started this launch, such as one whose folder was missing, still has its
    // saved scrollback on disk. Restarting without it would let the next save overwrite that file.
    if (node?.kind === 'terminal' && !host.isRunning(id) && !host.snapshot(id).data) {
      await runner.startNode(id, { initialScrollback: restoreSeed('terminal', scrollback.read(id)) })
    } else {
      await runner.restartNode(id)
    }
    clearExited(id)
  })

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
  runner.onRun((id, run) => {
    broadcast('pb:onRun', id, run)
    if (!run.running && !run.stoppedByYou && run.exitCode) notifier.runFailed(id)
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
  ipcMain.handle('pb:setUsageSecret', (_e, header: string) => usageSecret.save(header, parseSettings(readIfPresentSync(settingsFile)).usageUrl ?? ''))
  ipcMain.handle('pb:removeUsageSecret', () => usageSecret.remove())
  ipcMain.handle('pb:openUsageSignIn', () => openUsageSignIn(parseSettings(readIfPresentSync(settingsFile)).usageUrl ?? ''))
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
  ipcMain.handle('pb:getSettings',() => parseSettings(readIfPresentSync(settingsFile)))
  ipcMain.handle('pb:saveSettings', async (_e, next: Settings) => {
    const text = mergeSettings(readIfPresentSync(settingsFile), next)
    if (text === null) return { ok: false, reason: 'settings.json has a mistake in it, so saving would overwrite it. Fix it with Open file, under About, then try again.' }
    await writeAtomic(settingsFile, text)
    // A half-typed address is never fetched: reads only happen on the timer or on Test now, once one is set.
    const saved = parseSettings(text)
    usage.setOff(saved.usageSource === 'off')
    if (!sourceConfig(saved)) void usagePoller.refreshNow()
    onSettingsSaved?.()
    return { ok: true }
  })
  ipcMain.handle('pb:pickProgram', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('pb:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // The only way to arm a trigger. The control server has no route to the trigger service.
  ipcMain.handle('pb:armTrigger', (_e, id: string, shownSpec: string) => triggers.arm(id, shownSpec))
  ipcMain.handle('pb:disarmTrigger', (_e, id: string) => triggers.disarm(id))
  // Takes no prompt: what it sends is what's saved on the trigger.
  ipcMain.handle('pb:runTriggerNow', (_e, id: string) => triggers.runNow(id))
  ipcMain.handle('pb:readLaunchConfigs', (_e, folder: string) => listLaunchConfigs(folder))
  // PATCHBAY_SSH_CONFIG lets a test give its own file in place of the person's.
  ipcMain.handle('pb:listSshHosts', () => {
    const config = process.env.PATCHBAY_SSH_CONFIG || join(homedir(), '.ssh', 'config')
    return { hosts: sshHosts(readIfPresentSync(config) ?? ''), home: homedir(), installed: findSsh() !== null }
  })

  ipcMain.handle('pb:getApprovals', () => approvals.pending())
  // The only caller of approvals.answer. The control server has no route to it.
  ipcMain.handle('pb:answerApproval', (_e, requestId: string, decision: 'allow' | 'deny') => {
    approvals.answer(requestId, decision)
  })

  ipcMain.handle('pb:savePastedImage', (_e, bytes: Uint8Array, mime: string) => savePastedImage(dataDir, bytes, mime))
  ipcMain.handle('pb:saveBoardImage', (_e, bytes: Uint8Array, mime: string) => saveBoardImage(join(dataDir, 'whiteboards', 'images'), bytes, mime))
  ipcMain.handle('pb:readBoardImage', (_e, file: string) => readBoardImage(join(dataDir, 'whiteboards', 'images'), file))
  ipcMain.handle('pb:openTerminalLink', (_e, nodeId: string, target: string) => {
    const node = find(nodeId)
    const cwd = isSession(node) ? node.cwd : homedir()
    return openTerminalLink(cwd, target, {
      exists: existsSync,
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      reveal: (path) => shell.showItemInFolder(path)
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

  ipcMain.handle('pb:reopenClosed', async (_e, closedId: string) => {
    const id = reopenClosed(store, closedId, randomUUID())
    if (id) await runner.startNode(id)
  })
  // The chat view of an agent window. Read again as the conversation grows, so only the newest part is sent.
  ipcMain.handle('pb:readConversation', async (_e, nodeId: string) => {
    const node = find(nodeId)
    if (node?.kind !== 'claude') return { ok: false, reason: 'Only an agent window has a conversation.' }
    if (!node.transcriptPath) return { ok: true, messages: [] }
    try {
      return { ok: true, messages: await readMessagesTail(node.transcriptPath, CONVERSATION_MESSAGES) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, messages: [] }
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
    return nameFromOutput(await titleMaterial(node), (stdin) => {
      const settings = parseSettings(readIfPresentSync(settingsFile))
      const program = customLaunch({ terminal: settings.claudeTerminal, command: settings.claudeCommand }, TITLE_ARGS)
      return runToEnd(program, stdin, { cwd: neutral, env: cleanEnv(process.env, {}) })
    })
  })

  return {
    reattached(ids) {
      for (const id of ids) clearExited(id)
      broadcast('pb:onReattach', ids)
    }
  }
}
