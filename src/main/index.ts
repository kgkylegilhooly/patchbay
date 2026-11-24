import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, Tray, type Event as ElectronEvent } from 'electron'
import { createDocStore } from '../core/persist/docStore'
import { createScrollbackStore } from '../core/persist/scrollbackStore'
import type { AgentStatus } from '../shared/model'
import type { SystemMemory } from '../shared/resources'
import { createAppStore, type AppStore } from './appStore'
import { asleepText, createLog, logMemoryNowAndThen, watchEventLoop, watchWindow, type Log } from './watchdog'
import { noteWork, stallText, workLog } from './workLog'
import { startProgramsOffThread } from './proc/setup'
import { processGoneText } from './stuckParts'
import { createSendGuard, isGitBashFile } from './sessions/sendGuard'
import { claudeRunsBash, terminalProfiles } from './sessions/shell'
import { terminalStartFor } from './sessions/terminalStart'
import { registerTerminalProfileIpc } from './terminalProfilesIpc'
import { watchSignals, type SignalWatcher } from './sessions/signals'
import { parseUsageReport } from '../shared/usage'
import { createBrowserDriver } from './browser/driver'
import { createAfterGate } from './control/after'
import { loadOrCreateSecret, RpcRefusal, startControlServer, type ControlServer } from './control/server'
import { hookFromAnotherNode, refusalLog } from './control/hookIdentity'
import { createSendQueue } from './control/sendQueue'
import { createVerbs } from './control/verbs'
import { createPromptWitness } from './control/promptWitness'
import { withTeamVerb } from './control/teamVerb'
import { rpcSignal } from './control/rpcSignal'
import { systemGit } from '../core/git/service'
import { gitEnvFrom } from '../core/git/args'
import { reportViewSize } from './viewSize'
import { registerViewIpc } from './viewIpc'
import { createWorktree } from '../core/worktree/service'
import { registerRecipeIpc } from './recipes/ipc'
import { registerNeedsYouIpc } from './needsYou/ipc'
import { setupResources } from './resources/setup'
import { setupDiagnostics } from './diagnostics/setup'
import { createRecipeService } from './recipes/service'
import { createSetupGate } from './recipes/setupGate'
import { withRecipeVerbs } from './recipes/verbs'
import { setupWorkflows } from './workflows/setup'
import { createTaskService } from './tasks/service'
import { createWhiteboardExporter } from './whiteboardExport'
import { createMessageLog } from './messageLog'
import { createAgentEditLog } from './agentEdits'
import { pruneBoardImagesAsync } from './boardImages'
import { adoptAfterQuickBoot } from './bootAdopt'
import { createTriggerService } from './triggers/service'
import { triggerEventDeps } from './triggers/eventDeps'
import { broadcast, registerIpc } from './ipc'
import { createGithubReader, registerWorkIpc, workServices } from './workIpc'
import { registerSearchIpc } from './search/ipc'
import { registerReviewIpc } from './review/ipc'
import { registerDocsIpc } from './reader/ipc'
import { withDocVerbs } from './reader/verbs'
import { spotNear } from './control/verbs'
import { setupCompare } from './compare/setup'
import { setupFilesTouched } from './files/setup'
import { createAway, serveAway, type Away } from './files/away'
import { serveLastReply } from './lastReply'
import { withFilesVerbs } from './files/verbs'
import { setupProjects } from './projects/ipc'
import { setupSubagents } from './subagents/setup'
import {
  closeAction,
  createScrollbackSaver,
  decideInstance,
  EXITING_WAIT_MS,
  type ExitingMark,
  badgeFile,
  hideNotice,
  needsQuitConfirm,
  parseSettings,
  planReconnect,
  quitMenuLabels,
  quitQuestion,
  restoreSeed,
  trayState,
  type QuitIntent
} from './lifecycle'
import { createKeepAwake } from './keepAwake'
import { createNotifier } from './notifier'
import { createApprovals } from './sessions/approvals'
import { createBackgroundHost } from './sessions/backgroundHost'
import { createSessionHost } from './sessions/host'
import { pipeNameFor } from './sessions/hostProtocol'
import { guardExit, hostRuntime, lastHostLogLine, pruneHostRuntimes, spawnSessionHost } from './sessions/hostSpawn'
import { HELPER_PROBLEM_LOG, onHelperProblem } from '../core/proc/safeKill'
import { missedHooksDir, takeMissedHooks } from './sessions/missedHooks'
import { onClaudeNodesRemoved, pruneSessionSettings, removeSessionSettings } from './sessions/sessionSettingsFiles'
import { createNodeRunner } from './sessions/nodeRunner'
import { createStatusTracker } from './sessions/statusTracker'
import { createPortWatcher, readConsoleMembers, runNetstat, runProcessList } from './ports/ports'
import { readPage } from './usage/pageSource'
import { createUsageSecret } from './usage/usageSecret'
import { createUsageService } from './usage/usageService'
import { readClaudeAccount, readCodexUsage } from './usage/agentAccounts'
import { createCodexGate } from './usage/codexGate'
import { applyAgentUsageFixture } from './usage/agentUsageFixture'
import { sendToAgent } from './agentMessages'
import { cleanEnv, setEnvNotPassed } from './sessions/env'
import { agentsNow, readAgentsFrom } from './agentsAllowed'
import { continueAtReset, createAgentStops, stopFile } from './sessions/agentStops'
import { registerAgentStopIpc } from './agentStopsIpc'
import { setupSessionSync } from './sessionSyncIpc'
import { setupCodexStops } from './sessions/codexStopsSetup'
import { noteSubagentHook } from './subagents/setup'
import { heldReason } from '../shared/agentStop'
import { lazyUpdater } from './lazyUpdater'
import { createUpdates, type Updater } from './updates'
import { lookUpClaudeAhead, resolveClaudeAsync, type ClaudeProgram } from './sessions/claudeLaunch'
import { lookUpCodexAhead, resolveCodexAsync } from './sessions/codexLaunch'
import { noteFromNode, registerFileShelfIpc } from './fileShelf/ipc'
import { noteReaders } from './fileShelf/readers'

/** How often Codex's limits and the accounts are asked for again. */
const AGENT_USAGE_EVERY_MS = 5 * 60_000
/** A moment after launch, so starting up isn't slowed, then a few times a day. */
const UPDATE_FIRST_CHECK_MS = 30_000
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000
import { createUsagePoller, fetchEndpoint, sourceConfig, type ReadResult, type SourceConfig } from './usage/usageSource'
import { createAppProblems, serveAppProblems } from './appProblems'

let mainWindow: BrowserWindow | null = null
/** Set up first thing in boot. */
let log: Log | null = null
/** Held here because Electron removes a tray icon that's been collected. */
let tray: Tray | null = null

/**
 * How often the tray catches up. Sessions start and stop in several places, and this is cheap. A fallback only: status
 * changes, sessions ending and unseen changes refresh the tray as they happen.
 */
const TRAY_REFRESH_MS = 5000
const APP_ID = 'local.patchbay.app'
/**
 * Run from source with `npm run dev`, as when Patchbay is used to work on itself. It keeps its own data, session host
 * and single-instance lock, so it never meets an installed copy that's running: with the same ones it only brought that
 * copy forward and quit, and could have shared its sessions. Its title says so. Tests pass --user-data-dir and aren't this.
 */
const DEV_COPY = !app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')
const PORT_CHECK_MS = 5000
/** A hook that read the old endpoint just before this launch's was written can still land in a journal. */
const LATE_JOURNAL_CHECK_MS = 3000
/** Unused whiteboard pictures are cleared once start-up has settled. */
const BOARD_IMAGE_PRUNE_DELAY_MS = 30_000

/**
 * Windows only shows an app's notifications if a Start Menu shortcut carries its id. Test runs use a throwaway
 * --user-data-dir, and leave the real Start Menu alone.
 */
function ensureStartMenuShortcut(iconPath: string): void {
  if (!app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return
  const link = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Patchbay.lnk')
  const ok = shell.writeShortcutLink(link, existsSync(link) ? 'update' : 'create', {
    target: process.execPath,
    appUserModelId: APP_ID,
    icon: iconPath,
    iconIndex: 0,
    description: 'Patchbay'
  })
  if (!ok) console.error('Patchbay could not write its Start Menu shortcut, so Windows may not show its notifications.')
}

/**
 * For automated test runs: the window opens beside the screens, out of the taskbar, and never takes focus, so test
 * after test doesn't pop up over whatever the person is doing. It still draws and takes input from the test as usual.
 */
const QUIET_WINDOW = process.env.PATCHBAY_QUIET_WINDOW === '1'

function quietPlace(): { x: number; y: number } {
  const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width))
  return { x: right + 100, y: 0 }
}

function createWindow(onClose: (e: ElectronEvent) => void, icon: string): BrowserWindow {
  const win = new BrowserWindow({
    ...(QUIET_WINDOW ? { show: false, skipTaskbar: true, ...quietPlace() } : {}),
    width: 1280,
    height: 800,
    backgroundColor: '#0e0e10',
    title: DEV_COPY ? 'Patchbay (dev)' : 'Patchbay',
    icon,
    // The app draws its own title bar and menus. Windows keeps its buttons at the right end.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1f1f22', symbolColor: '#ececee', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // For browser nodes only. Every <webview> is locked down as it attaches: see browser/guard.ts.
      webviewTag: true,
      // The chime has to play with no click first, including while the window is hidden.
      autoplayPolicy: 'no-user-gesture-required',
      ...(DEV_COPY ? { additionalArguments: ['--patchbay-dev-copy'] } : {})
    }
  })
  if (QUIET_WINDOW) win.once('ready-to-show', () => win.showInactive())
  // Links open through openTerminalLink. Nothing else may take over the window that holds the canvas.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // The page's own title would otherwise replace the one that says this is a dev copy.
  if (DEV_COPY) win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', onClose)
  win.on('focus', () => win.flashFrame(false))
  const watch = log ? watchWindow(win, { dialog, log, app, ipcMain }) : null
  win.on('closed', () => {
    watch?.dispose()
    mainWindow = null
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

const RENDER_TIMEOUT_MS = 8000
const renders = new Map<string, (png: unknown) => void>()
ipcMain.on('pb:whiteboardRendered', (e, requestId: string, png: unknown) => {
  if (e.sender !== mainWindow?.webContents) return
  renders.get(requestId)?.(png)
})

/** Asks the app window to draw a board's SVG as a PNG. Null if there's no window, or it doesn't answer in time. */
function renderWhiteboard(svg: string, width: number, height: number): Promise<unknown> {
  const win = mainWindow
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(null), RENDER_TIMEOUT_MS)
    const done = (png: unknown): void => {
      clearTimeout(timer)
      renders.delete(requestId)
      resolve(png)
    }
    renders.set(requestId, done)
    win.webContents.send('pb:onRenderWhiteboard', requestId, svg, width, height)
  })
}

function focusWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  // A test run's window comes back as it first appeared: shown, off to the side, without taking focus.
  if (QUIET_WINDOW) return void mainWindow.showInactive()
  mainWindow.show()
  mainWindow.focus()
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

async function boot(): Promise<void> {
  // Electron's default menu would claim keys like Ctrl+W and Ctrl+R from the terminals.
  Menu.setApplicationMenu(null)
  const dataDir = app.getPath('userData')
  const resourceDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  const settingsFile = join(dataDir, 'settings.json')
  // What went wrong, and when, for a hang or crash that leaves nothing else behind. See watchdog.ts.
  log = createLog(join(dataDir, 'logs'))
  onHelperProblem((why) => log?.write(`${HELPER_PROBLEM_LOG} ${why}`))
  log.write(`Patchbay ${app.getVersion()} started (Electron ${process.versions.electron}, pid ${process.pid}).`)
  // A sleep isn't a stall: the log once said "blocked for 39254.9 s" for a night with the lid shut.
  let suspended = false
  powerMonitor.on('suspend', () => (suspended = true))
  watchEventLoop((ms, since) => log?.write(stallText(ms, workLog.during(since, Date.now()))), undefined, undefined, {
    onAsleep: (ms) => log?.write(asleepText(ms)),
    slept: () => {
      const was = suspended
      suspended = false
      return was
    }
  })
  logMemoryNowAndThen(app, log)
  startProgramsOffThread(__dirname, (line) => log?.write(line))
  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') log?.write(processGoneText(details))
  })
  const currentSettings = () => parseSettings(readIfPresent(settingsFile))
  setEnvNotPassed(() => currentSettings().envNotPassed)
  readAgentsFrom(currentSettings)
  {
    // Found now, off the main thread, so the first agent started doesn't wait on where.exe. See claudeLaunch.ts.
    const s = currentSettings()
    void lookUpClaudeAhead({ terminal: s.claudeTerminal, command: s.claudeCommand })
      .then(() => lookUpClaudeAhead({ command: s.codexCommand }))
      .then(() => lookUpCodexAhead())
      .catch(() => {})
  }
  // A failed save is a banner in the window that clears when saving works again, not a dialog that held up the app.
  const problems = createAppProblems({ retrySave: () => docStore.flush(), push: (p) => broadcast('pb:problems:onChange', p) })
  const docStore = createDocStore(dataDir, {
    onSaveError(e) {
      console.error('Patchbay autosave failed:', e)
      problems.saveFailed(e, dataDir)
    },
    onSaved: () => problems.saved()
  })
  let store: AppStore
  try {
    store = createAppStore(docStore)
  } catch (e) {
    // Starting empty here could end with an empty canvas saved over good data.
    dialog.showErrorBox(
      'Patchbay can\'t open your canvas',
      `The save file in ${dataDir} exists but couldn't be read, so Patchbay is closing rather than risk replacing it.\n\n${String(e)}`
    )
    app.exit(1)
    return
  }
  // Nothing can bring back a deleted board at startup, so pictures no board uses can go, once they're old enough.
  // Which those are is settled now, but they go later and off the main thread: looking took 120 ms before the window.
  const boardImagesAtStart = new Set(store.get().nodes.flatMap((n) => (n.kind === 'whiteboard' ? n.shapes.flatMap((s) => (s.type === 'image' ? [s.file] : [])) : [])))
  setTimeout(() => void pruneBoardImagesAsync(join(dataDir, 'whiteboards', 'images'), boardImagesAtStart).catch(() => {}), BOARD_IMAGE_PRUNE_DELAY_MS).unref()

  // Held until clicked: Electron drops the click handler of a notification that's been collected.
  const showing = new Set<Notification>()
  const showToast = ({ title, body, click }: { title: string; body: string; click: () => void }): Promise<'shown' | 'failed' | 'unsupported'> =>
    new Promise((resolve) => {
      if (!Notification.isSupported()) return resolve('unsupported')
      // Silent, because the chime is the app's own sound and has its own switch.
      const n = new Notification({ title, body, silent: true, icon: join(resourceDir, 'icon.png') })
      showing.add(n)
      n.on('show', () => resolve('shown'))
      n.on('failed', (_e, error) => {
        console.error('Patchbay notification failed:', error)
        showing.delete(n)
        resolve('failed')
      })
      n.on('click', () => {
        showing.delete(n)
        click()
      })
      n.on('close', () => showing.delete(n))
      n.show()
    })
  const notifier = createNotifier({
    show(toast) {
      if (currentSettings().notifications !== 'off') void showToast(toast)
    },
    alert() {
      if (currentSettings().sound !== 'off') broadcast('pb:onChime')
      if (mainWindow && !QUIET_WINDOW && !mainWindow.isFocused()) mainWindow.flashFrame(true)
    },
    windowFocused: () => mainWindow?.isFocused() ?? false,
    titleOf: (id) => store.get().nodes.find((n) => n.id === id)?.title ?? 'Claude',
    reveal(id) {
      focusWindow()
      notifier.markSeen(id)
      const projectId = store.get().nodes.find((n) => n.id === id)?.projectId
      if (projectId) store.dispatch({ op: 'switchProject', id: projectId })
      broadcast('pb:onCenterNode', id)
    }
  })

  const controlDir = join(dataDir, 'control')
  // Not roaming: a copy of the program for this PC only. See hostRuntime.
  const hostRuntimeDir = process.env.PATCHBAY_HOST_RUNTIME_DIR || join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Patchbay', 'host-runtime')
  let runtimeInUse = ''
  const host = createBackgroundHost({
    pipe: pipeNameFor(dataDir),
    secret: loadOrCreateSecret(join(controlDir, 'host-secret')),
    // Only acceptance runs set this, to act out an update between two launches.
    protocol: Number(process.env.PATCHBAY_HOST_PROTOCOL) || undefined,
    spawnHost: async () => {
      // A packaged build runs its host from a copy of itself, so a new version can be installed under running sessions.
      const runtime = app.isPackaged ? await hostRuntime({ installDir: dirname(process.execPath), baseDir: hostRuntimeDir, version: app.getVersion(), mainDir: __dirname }) : null
      if (runtime) runtimeInUse = dirname(runtime.exe)
      spawnSessionHost({ mainDir: runtime?.mainDir ?? __dirname, dataDir, version: app.getVersion(), exe: runtime?.exe })
    },
    createLocal: () => createSessionHost(),
    explainFailure: () => lastHostLogLine(controlDir)
  })
  const approvals = createApprovals()
  const tracker = createStatusTracker({ notify: (id: string, status: AgentStatus) => notifier.notify(id, status) })
  const keepAwake = createKeepAwake({
    start: () => powerSaveBlocker.start('prevent-app-suspension'),
    stop: (id) => powerSaveBlocker.stop(id),
    enabled: () => currentSettings().keepAwake !== 'off'
  })
  tracker.onChange(() => keepAwake.update(tracker.all()))
  app.on('will-quit', () => keepAwake.dispose())
  const scrollback = createScrollbackStore(dataDir)
  const saver = createScrollbackSaver({
    snapshot: (id) => host.snapshot(id).data,
    write: (id, data) => scrollback.write(id, data)
  })
  const secret = loadOrCreateSecret(join(dataDir, 'secret'))
  const endpointFile = join(controlDir, 'endpoint.json')
  const journalDir = missedHooksDir(controlDir)
  // Hooks that fire many times a turn, and the status line, leave a file here instead of starting Node. See signals.ts.
  const signalDir = claudeRunsBash() ? join(dataDir, 'sessions', 'signals') : undefined
  let signals: SignalWatcher | null = null
  // Keeps Patchbay's own run of Codex, which reads its limits, apart from a Codex session starting. See codexGate.ts.
  const codexGate = createCodexGate()
  /** The PC's memory, once the resource monitor below is up. Until then no start waits for memory. */
  let memoryNow: () => SystemMemory | null = () => null
  /** What changed while a resumed agent was away, shown on its node: made once files-touched exists, below. */
  let away: Away | null = null
  const runner = createNodeRunner({
    host,
    tracker,
    store,
    approvals,
    ctx: {
      sessionDir: join(dataDir, 'sessions'),
      hookScript: join(resourceDir, 'hook.cjs'),
      statusLineScript: join(resourceDir, 'statusline.cjs'),
      signalDir,
      latestSignal: (id) => signals?.latestHook(id),
      beforeCodexStart: () => codexGate.sessionStarting(),
      refreshHost: () => host.refresh(),
      onReattached: (id) => noteReattached(id),
      onResumedStart: (id) => void away?.resumed(id),
      pluginDir: join(resourceDir, 'skill'),
      cliDir: join(resourceDir, 'cli'),
      endpointFile,
      secret,
      settings: currentSettings,
      typePrefix: (id) => sendGuard.prefixFor(id),
      // Journalled while Patchbay was closed, so checked here as onHook checks live ones.
      takeMissedHooks: (id) =>
        takeMissedHooks(journalDir, id).filter((e) => !hookFromAnotherNode(id, { session_id: e.session_id }, store.get().nodes, (n) => host.isRunning(n))),
      onMissedStopFailure: (id, event) => stops.noteHook(id, event),
      // Sessions in the background host post their hooks to it, and start nothing. See docs/plans/host-hooks.md.
      // A host still starting after a quick boot is waited for, so a session started meanwhile still gets its port.
      hostHookPort: () => (host.info().mode === 'starting' ? host.connect().then(() => host.hookPort()) : host.hookPort()),
      systemMemory: () => memoryNow()
    }
  })
  const usage = createUsageService({ dataDir })
  // Why agents stopped on StopFailure, such as a usage limit, and holding what's sent to them until it resets.
  const stops = createAgentStops({ tracker, plan: () => usage.state().plan, continueEnabled: () => currentSettings().continueAtReset === 'on', store: stopFile(join(dataDir, 'agent-stops.json'), (line) => log?.write(line)) })
  registerAgentStopIpc(stops)
  // Codex's limits, failures and interrupts, from its rollout files, as the same stops and statuses.
  const codexStops = setupCodexStops({ store, tracker, runner, stops, log: (line) => log?.write(line) })
  if (signalDir) {
    signals = watchSignals({
      dir: signalDir,
      onHook: (id, name) => void runner.handleHook(id, { hook_event_name: name }).catch((e: unknown) => log?.write(`A signalled ${name} failed: ${String(e)}`)),
      onStatus: (id, text) => usage.report(id, parseUsageReport(JSON.parse(text))),
      log: (message) => log?.write(message)
    })
    app.on('will-quit', () => signals?.close())
  }
  const usageSecret = createUsageSecret({ file: join(dataDir, 'usage-secret.bin'), crypto: safeStorage })
  const readUsage = async (cfg: SourceConfig): Promise<ReadResult> => {
    if (cfg.source === 'page') return readPage(cfg)
    const { header, mismatch } = usageSecret.forUrl(cfg.url)
    if (mismatch) return { ok: false, problem: `The sign-in header was saved for ${mismatch}. Save it again to use it with this address.` }
    return fetchEndpoint(cfg, header ?? null)
  }
  const usagePoller = createUsagePoller({
    settings: () => sourceConfig(currentSettings()),
    read: readUsage,
    budget: () => usage.state().budget,
    setBudget: (b) => usage.setBudget(b)
  })
  const gate = createAfterGate({ store, tracker, runner })
  // The Files shelf: references to the files shared in each project. See src/main/fileShelf.
  const fileShelf = registerFileShelfIpc({ dataDir, store, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame, windows: () => (mainWindow ? [mainWindow.webContents] : []), log: (line) => log?.write(line) })
  // Documents opened in a Reader go on the shelf too.
  noteReaders(store, fileShelf)
  const browser = createBrowserDriver({ dataDir, store, push: (id, state) => broadcast('pb:onBrowserState', id, state), onShot: (id, path) => noteFromNode(fileShelf, store, id, path, 'evidence') })
  browser.install()
  const work = workServices()
  const github = createGithubReader(store, work.git, work.gh)
  // One line into each session, shared by `patchbay send` and triggers.
  // Text main types into a Git Bash terminal after a resize gets a byte ahead of it for bash to drop. See sendGuard.ts.
  const sendGuard = createSendGuard({
    isGitBash: (id) => {
      const node = store.get().nodes.find((n) => n.id === id)
      return node?.kind === 'terminal' && node.sshHost === undefined && isGitBashFile(terminalStartFor({ settings: currentSettings }, node, true).file)
    }
  })
  const sendQueue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), prefix: sendGuard.prefixFor, pasteOn: sendGuard.pasteOn, draft: sendGuard, hold: stops })
  continueAtReset(stops, sendQueue)
  const messages = createMessageLog(join(dataDir, 'messages.json'))
  const agentEdits = createAgentEditLog(join(dataDir, 'agent-edits.json'))
  ipcMain.handle('pb:getAgentEdits', () => agentEdits.all())
  ipcMain.on('pb:settleAgentEdits', (e, id: string) => {
    if (e.sender === mainWindow?.webContents && typeof id === 'string') agentEdits.settle(id)
  })
  ipcMain.handle('pb:getMessages', () => messages.all())
  const tasks = createTaskService(store, dataDir, () => docStore.flush())
  // Output of attempts no project records any more. Once the canvas has settled, so it costs start-up nothing.
  setTimeout(() => tasks.pruneOutput(), 60_000).unref()
  ipcMain.handle('pb:taskShow', (e, projectId: string, taskId: string) => {
    if (e.sender !== mainWindow?.webContents || e.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Tasks are available only in the application UI')
    return tasks.show(projectId, taskId)
  })
  ipcMain.handle('pb:taskAccept', (e, projectId: string, taskId: string, submissionId: string) => {
    if (e.sender !== mainWindow?.webContents || e.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Only the application UI can accept tasks')
    return tasks.accept(projectId, taskId, submissionId)
  })
  const whiteboards = createWhiteboardExporter({ dir: join(dataDir, 'whiteboards'), render: renderWhiteboard })
  // What agents' UserPromptSubmit hooks say they submitted, so a send to one with no transcript yet can be confirmed.
  const prompts = createPromptWitness()
  const verbs = createVerbs({ prompts, tasks, browser, store, runner, tracker, host, gate, queue: sendQueue, github, whiteboards, onMessage: (from, to, text) => broadcast('pb:onMessage', messages.add(from, to, text)), onNoteEdit: (edit) => (agentEdits.note(edit), broadcast('pb:onNoteEdit', edit)), onBoardEdit: (edit) => (agentEdits.board(edit), broadcast('pb:onBoardEdit', edit)), defaultAgent: () => agentsNow().default, agents: agentsNow, terminalProfiles: () => terminalProfiles(currentSettings()), stops, log: (line) => log?.write(line), onFilePinned: (projectId, path, by) => fileShelf.note(projectId, { path, source: 'agent', at: Date.now(), nodeTitle: by }) })
  // Recipes: saved setups of nodes, and the gate that holds their agents until setup succeeds. See src/main/recipes.
  const setupGate = createSetupGate({ store, tracker, runner, gate })
  const recipes = createRecipeService({ store, runner, gate, setupGate, dataDir, launcher: join(resourceDir, 'launch-run.cjs'), toplevel: (folder) => work.git.toplevel(folder), createWorktree })
  // Which files each agent session edited, from its transcript, with a snapshot as each turn starts. See src/main/files.
  const filesTouched = setupFilesTouched({ store, tracker, dataDir, log: (line) => log?.write(line) })
  away = createAway({ changes: (id) => filesTouched.awayChanges(id), send: (id, text) => sendToAgent({ store, status: (i) => tracker.get(i), queue: sendQueue }, id, text), push: (a) => broadcast('pb:away:onChange', a) })
  serveAway(away, (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame)
  serveLastReply(store, (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame)
  // The reader: Markdown files shown read-only, with comments for agents. See src/main/reader.
  const docs = registerDocsIpc({ dataDir, store, broadcast, near: spotNear })
  // Workflows: saved processes whose steps run in order, each finishing on evidence. See src/main/workflows.
  const workflows = setupWorkflows({ store, runner, tracker, stops, isRunning: (id) => host.isRunning(id), isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame, tasks, dataDir, launcher: join(resourceDir, 'launch-run.cjs'), toplevel: (folder) => work.git.toplevel(folder), createWorktree, send: (id, text) => sendToAgent({ store, status: (i) => tracker.get(i), queue: sendQueue }, id, text), docs: docs.service, broadcast, log: (line) => log?.write(line) })
  const allVerbs = withTeamVerb(workflows.wrap(withDocVerbs(withFilesVerbs(withRecipeVerbs(verbs, { store, service: recipes }), { store, service: filesTouched }), { store, docs: docs.service, comments: docs.comments })), { store, tracker, stops, messages: () => messages.all(), git: systemGit(gitEnvFrom(cleanEnv(process.env, {}))) })
  const triggers = createTriggerService({ store, tracker, host, queue: sendQueue, ...triggerEventDeps({ runner, dataDir, launcher: join(resourceDir, 'launch-run.cjs') }), held: (id) => {
    const stop = tracker.get(id) === 'unknown' ? stops.get(id) : undefined
    return (stop && heldReason(stop, Date.now())) ?? undefined
  } })

  // Before anything can report in: a session's hooks need its node to be known, and the first of them might be next.
  // With no host running there's nothing to report in, so the window doesn't wait for a new one to start.
  const hostAtBoot = await host.connect({ quick: true })
  // Copies of older builds that no host runs from any more. Once things have settled, so it costs start-up nothing.
  if (app.isPackaged) setTimeout(() => void pruneHostRuntimes(hostRuntimeDir, runtimeInUse), 60_000).unref()
  const adoptLive = (skip: ReadonlySet<string> = new Set()): string[] => {
    const plan = planReconnect(store.get(), host.sessions())
    const adopt = plan.adopt.filter((id) => !skip.has(id))
    for (const id of plan.strays) {
      // A session with no node can't be seen or used. After a damaged save, though, the node may be what's missing.
      if (!host.isRunning(id)) host.forget(id)
      else if (!store.loaded.quarantined) void host.kill(id)
    }
    for (const id of adopt) {
      runner.adoptNode(id)
      const kind = store.get().nodes.find((n) => n.id === id)?.kind
      // Claude draws its own screen without the alternate screen, so its mode alone wouldn't show it needs this.
      if (kind === 'claude') host.repaintOnNextResize(id)
      else saver.markDirty(id)
    }
    return adopt
  }
  const adopted = adoptLive()
  // A node at its usage limit before the app restarted still is, if its session came back.
  stops.retain(adopted)
  // A Claude node's settings hold its hook token, so they go with the node. Never those of a session still running.
  const sessionDir = join(dataDir, 'sessions')
  // After a damaged save the canvas may be what's missing, so nothing is pruned then.
  if (!store.loaded.quarantined) pruneSessionSettings(sessionDir, (id) => store.get().nodes.some((n) => n.id === id) || host.isRunning(id))
  onClaudeNodesRemoved(store, (id) => {
    if (!host.isRunning(id)) removeSessionSettings(sessionDir, id)
  })

  const noteRefusal = refusalLog((line) => log?.write(line))
  const onHook = async (id: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
      const owner = hookFromAnotherNode(id, payload, store.get().nodes, (n) => host.isRunning(n))
      if (owner) {
        noteRefusal(id, owner, payload.hook_event_name)
        throw new RpcRefusal("This hook came from another node's session.")
      }
      signals?.heardHook(id)
      prompts.heard(id, payload)
      // A Codex turn that failed ends on Stop; it's taken as the StopFailure Claude would have sent.
      const { payload: heard, limits, ignore } = await codexStops.translate(id, payload)
      if (ignore) return {}
      const answer = await runner.handleHook(id, heard, signal)
      stops.noteHook(id, heard, limits)
      const hooked = store.get().nodes.find((n) => n.id === id)
      noteSubagentHook(id, heard, hooked?.kind === 'claude' ? hooked.transcriptPath : null)
      if (payload.hook_event_name !== 'SessionStart') return answer
      // An agent learns where it is on the canvas as its session starts. hook.cjs hands this on as context.
      const context = await verbs(id, 'whoami', {}).then((w) => (w as { text?: string }).text, () => undefined)
      return { ...((answer as object | undefined) ?? {}), context }
  }
  const server: ControlServer = await startControlServer({
    secret,
    endpointFile,
    onHook,
    onRpc: (caller, verb, args, signal) => rpcSignal.run(signal, () => allVerbs(caller, verb, args)),
    onUsage: (id, report) => usage.report(id, report)
  })

  const portWatcher = createPortWatcher({
    runNetstat,
    runProcessList,
    consoleMembers: readConsoleMembers,
    roots: () => {
      const roots = new Map<number, string>()
      for (const node of store.get().nodes) {
        const pid = host.pid(node.id)
        if (pid !== null) roots.set(pid, node.id)
      }
      return roots
    },
    // Nobody's looking, so it isn't worth running netstat every few seconds.
    visible: () => !!mainWindow?.isVisible()
  })
  setInterval(() => (noteWork('port check'), void portWatcher.tick()), PORT_CHECK_MS).unref()
  let getAttention: () => string[] = () => []
  const testNotification = () => showToast({ title: 'Patchbay', body: 'Notifications are working.', click: focusWindow })
  // The server is up, so from here on hooks are delivered. What came before is in the journals.
  for (const id of adopted) runner.catchUpHooks(id)
  // Hooks the host served since this app connected waited for this, so they come after the journal's, in order.
  host.serveHooks(onHook)
  setTimeout(() => {
    for (const id of adopted) runner.catchUpHooks(id)
  }, LATE_JOURNAL_CHECK_MS).unref()

  let phase: 'running' | 'confirming' | 'stopping' | 'done' = 'running'
  let quitIntent: QuitIntent = 'leave-running'
  const quitWith = (intent: QuitIntent): void => {
    quitIntent = intent
    app.quit()
  }

  /** Starts whatever should be running and isn't, below what it last showed. Returns what it started. */
  const startDead = async (): Promise<string[]> => {
    // A host started at boot may still be coming up. Its sessions' hooks need its port, so starting waits for it.
    await host.connect()
    const plan = planReconnect(store.get(), host.sessions())
    for (const id of plan.finishedRuns) {
      const ended = host.sessions().find((s) => s.id === id)
      runner.noteFinishedRun(id, ended?.exitCode ?? null, ended?.exitedAt ?? null)
    }
    for (const id of plan.terminals) {
      // The host's copy is newer than the saved one, when it still has it.
      const held = plan.endedInHost.includes(id) ? host.snapshot(id).data : ''
      await runner.startNode(id, { initialScrollback: restoreSeed('terminal', held || scrollback.read(id)), restored: true })
    }
    // They were running when Patchbay last saw them, so the soft limit on agents at once doesn't hold them back.
    for (const id of plan.claude) await runner.startNode(id, { restored: true })
    gate.evaluate()
    setupGate.evaluate()
    void workflows.recover()
    return [...plan.terminals, ...plan.claude]
  }

  let ipcHooks: { reattached(ids: string[]): void; terminalShownExited(id: string): boolean } = { reattached: () => {}, terminalShownExited: () => false }
  const stopHost = async (): Promise<void> => {
    await runner.stopAll()
    await saver.flush()
    await host.stopHost()
  }
  /** Ends the host from another version, or an already-lost one, and brings everything back. */
  const replaceHost = async (): Promise<void> => {
    await host.stopHost()
    await host.connect()
    const ids = await startDead()
    ipcHooks.reattached(ids)
  }
  serveAppProblems(problems, { replaceHost, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame })
  const resolveOtherHost = async (choice: 'stop-it' | 'quit'): Promise<void> => {
    if (host.info().mode !== 'other-version') return
    if (choice === 'quit') quitWith('leave-running')
    else await replaceHost()
  }
  ipcHooks = registerIpc({
    dataDir, log: log ?? undefined, signals: signals ?? undefined, sendGuard, store, host, runner, tracker, approvals, gate, scrollback, saver, notifier, testNotification, attention: () => getAttention(), usage, usageSecret, usagePoller, ports: portWatcher, browser,
    hostInfo: () => host.info(),
    quit: quitWith,
    stopHost,
    resolveOtherHost,
    triggers,
    launchRunner: join(resourceDir, 'launch-run.cjs'),
    onSettingsSaved: () => (keepAwake.update(tracker.all()), stops.refresh())
  })
  // A host that was there but slow to answer boot's first knock is found by the connect that goes on: its sessions are
  // adopted then, and their views fetched again. See bootAdopt.ts.
  void adoptAfterQuickBoot(hostAtBoot, () => host.connect(), () => adoptLive(new Set(adopted)), (more) => {
    stops.retain(more)
    for (const id of more) runner.catchUpHooks(id)
    ipcHooks.reattached(more)
  }).catch((e: unknown) => log?.write(`Adopting sessions after start-up failed: ${String(e)}`))
  registerWorkIpc({ store, startNode: (id) => runner.startNode(id), git: work.git, gh: work.gh, reader: github, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame })
  const search = registerSearchIpc({ dataDir, mainDir: __dirname, store, messages: () => messages.all(), status: (id) => tracker.get(id), git: work.git, startNode: (id) => runner.startNode(id), log: (line) => log?.write(line) })
  registerRecipeIpc({ service: recipes, setupGate })
  registerNeedsYouIpc({ store, tracker, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame })
  // Memory and CPU: the resource view in Settings, and a warning when the PC runs short. See src/main/resources.
  const resources = setupResources({ dataDir, store, host, hosted: () => host.sessions(), hostPid: () => host.info().pid ?? null, tracker, settings: currentSettings, broadcast, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame, onCheck: (kind) => {
    // An agent waiting for memory starts once it's no longer short, one a check.
    if (kind !== 'commit') void runner.startHeld()
  } })
  memoryNow = () => resources.systemMemory()
  // Settings > About's versions, Copy diagnostics and Open log folder. See src/main/diagnostics.
  setupDiagnostics({ dataDir, store, host, status: (id) => tracker.get(id), sessionDir, settings: currentSettings, memory: () => resources.reading(), logFile: log?.file ?? null, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame })
  registerReviewIpc({ dataDir, store, tasks, send: (id, text) => sendToAgent({ store, status: (i) => tracker.get(i), queue: sendQueue }, id, text), isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame, log: (line) => log?.write(line) })
  registerTerminalProfileIpc({ settingsFile, log: (line) => log?.write(line) })
  // Two attempts at one brief, each in its own worktree from one recorded commit. See src/main/compare.
  setupCompare({ store, runner, git: work.git, dataDir, launcher: join(resourceDir, 'launch-run.cjs'), persist: () => docStore.flush() })
  // The projects manager, and archiving, which stops a project's sessions first. See src/main/projects.
  setupProjects({
    dataDir, store, isRunning: (id) => host.isRunning(id), stopNode: (id) => runner.stopNode(id), disarmTrigger: (id) => triggers.disarm(id),
    forgetOutput: async (id) => {
      saver.forget(id)
      host.forget?.(id)
      await scrollback.remove(id)
    },
    markSeen: (id) => notifier.markSeen(id),
    isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame
  })
  // Live cards for a Claude window's subagents, kept in memory only. See src/main/subagents.
  setupSubagents({ store, tracker, broadcast, log: (line) => log?.write(line) })
  ipcMain.handle('pb:sendToAgent', (_e, id: string, text: string) => sendToAgent({ store, status: (i) => tracker.get(i), queue: sendQueue }, id, text))
  host.onInfo((info) => broadcast('pb:onHostInfo', info))
  // The canvas, the app's copy of each session and the host kept in agreement. See docs/plans/session-sync.md.
  function noteReattached(id: string): void {
    if (store.get().nodes.find((n) => n.id === id)?.kind === 'claude') host.repaintOnNextResize(id)
    else saver.markDirty(id)
    ipcHooks.reattached([id])
  }
  setupSessionSync({ store, host, runner, tracker, terminalShownExited: (id) => ipcHooks.terminalShownExited(id), latestSignal: (id) => signals?.latestHook(id), window: () => mainWindow, isAppUi: (e) => e.sender === mainWindow?.webContents && e.senderFrame === mainWindow.webContents.mainFrame, log: (line) => log?.write(line) })

  // The window doesn't wait for sessions to come back, which took a second or more with many of them: it shows them
  // starting. Triggers do wait, so a slot that passed while closed is judged against the real state.
  void startDead()
    .catch((e: unknown) => console.error('Patchbay could not restart every session:', e))
    .then(() => triggers.start())
  usage.setOff(currentSettings().usageSource === 'off')
  usagePoller.start()
  // Codex's limits and both accounts come from asking the programs themselves, which spends no quota.
  const refreshAgents = async (): Promise<void> => {
    if (currentSettings().usageSource === 'off') return
    // Scenes and acceptance runs show made-up numbers, never the person's own. See agentUsageFixture.ts.
    if (applyAgentUsageFixture(process.env, usage)) return
    try {
      usage.setClaudeAccount(await readClaudeAccount(await resolveClaudeAsync()))
    } catch {
      // No claude on PATH, or it couldn't say. The panel then shows no account line.
    }
    let codex: ClaudeProgram
    try {
      codex = await resolveCodexAsync()
    } catch {
      return // Codex isn't installed, so it has no section.
    }
    try {
      const read = await codexGate.read(() => readCodexUsage(codex))
      if (read) usage.setCodex(read)
      // A Codex session has just started, so this waits until it has settled rather than risk crashing it.
      else setTimeout(() => void refreshAgents(), codexGate.waitMs() + 1000).unref()
    } catch (e) {
      usage.setCodex({ problem: `Codex didn't say its limits: ${(e as Error).message}`, at: Date.now() })
    }
  }
  void refreshAgents()
  const agentTimer = setInterval(() => (noteWork('agent usage refresh'), void refreshAgents()), AGENT_USAGE_EVERY_MS)
  agentTimer.unref()

  const shutdown = async (intent: QuitIntent): Promise<void> => {
    triggers.stop()
    saver.stop()
    usagePoller.stop()
    clearInterval(agentTimer)
    const failures: unknown[] = []
    // Preferences live in the window's storage, which app.exit would otherwise drop if they changed moments ago.
    session.defaultSession.flushStorageData()
    await browser.flush()
    const save = async (): Promise<void> => {
      await saver.flush()
      await docStore.flush().catch((e: unknown) => failures.push(e))
      await usage.flush()
      await messages.flush()
      await agentEdits.flush()
      await search.stop()
      await fileShelf.flush()
      // A verification left running would outlive the record it reports to. On next launch its attempt reads interrupted.
      tasks.stopAll()
    }
    // Saved before stopping sessions in case that hangs, and after because stopping can change the doc.
    await save()
    if (intent === 'stop-all') {
      await runner.stopAll()
      await save()
      await host.stopHost()
    }
    // Held requests end here, which leaves each of them to Claude's own terminal prompt.
    await server.close()
    await save()
    if (intent !== 'stop-all') {
      // With nothing in it, a host would only sit there until its idle limit.
      if (host.info().mode === 'background' && host.info().running === 0) await host.stopHost()
      else await host.detach()
    }
    if (failures.length) {
      dialog.showErrorBox('Patchbay couldn\'t save', `Your latest canvas changes may be lost.\n\n${String(failures[0])}`)
    }
  }

  const requestQuit = async (): Promise<void> => {
    if (phase !== 'running') return
    const question = quitQuestion(quitIntent, host.info(), currentTrayState().running, needsQuitConfirm(store.get(), tracker.all()))
    let intent = quitIntent
    // Each request says for itself what it wants, so a cancelled one doesn't colour the next.
    quitIntent = 'leave-running'
    if (question) {
      phase = 'confirming'
      const { answers, ...text } = question
      const options = { type: 'warning' as const, ...text }
      // Asked from the tray, the window may be hidden, and a question attached to it wouldn't be seen.
      const answer = mainWindow?.isVisible() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
      const chosen = answers[answer.response]
      if (!chosen) {
        phase = 'running'
        return
      }
      intent = chosen
    }
    phase = 'stopping'
    try {
      await shutdown(intent)
    } finally {
      phase = 'done'
      markExiting()
      guardExit(app.getVersion())
      app.exit(0)
    }
  }

  // Updates. The background host runs from this app's own program file, which an installer can't replace while it
  // runs, so updating ends every session first. Agents resume their conversations when the new version starts.
  // electron-updater loads when first used, not on the way to the window. See lazyUpdater.ts.
  const updates = createUpdates({ updater: lazyUpdater(() => (require('electron-updater') as typeof import('electron-updater')).autoUpdater as unknown as Updater), feed: () => currentSettings().updateFeed, packaged: app.isPackaged })
  updates.onChange((s) => broadcast('pb:onUpdateState', s))
  ipcMain.handle('pb:getUpdateState', () => updates.state())
  ipcMain.handle('pb:checkForUpdates', () => updates.check())
  ipcMain.handle('pb:restartToUpdate', async () => {
    if (!updates.ready() || phase !== 'running') return
    phase = 'stopping'
    try {
      await shutdown('stop-all')
    } finally {
      phase = 'done'
      markExiting()
      guardExit(app.getVersion())
      updates.install()
    }
  })
  const autoCheck = (): void => {
    if (currentSettings().updateCheck !== 'off' && currentSettings().updateFeed?.trim()) void updates.check()
  }
  setTimeout(autoCheck, UPDATE_FIRST_CHECK_MS).unref()
  setInterval(() => (noteWork('update check'), autoCheck()), UPDATE_CHECK_EVERY_MS).unref()

  const holdUntilSaved = (e: ElectronEvent): void => {
    if (phase === 'done') return
    e.preventDefault()
    void requestQuit()
  }
  const currentTrayState = () => trayState(store.get(), tracker.all(), (id) => host.isRunning(id), notifier.unseen())

  let hideNoticeShown = false
  const onWindowClose = (e: ElectronEvent): void => {
    if (phase === 'done') return
    e.preventDefault()
    const { running } = currentTrayState()
    if (phase === 'running' && closeAction(running) === 'hide-to-tray') {
      mainWindow?.hide()
      const body = hideNotice(running, hideNoticeShown)
      hideNoticeShown = true
      if (body && currentSettings().notifications !== 'off') void showToast({ title: 'Patchbay', body, click: focusWindow })
    } else void requestQuit()
  }

  app.on('before-quit', holdUntilSaved)
  // An instance on its way out mustn't bring a closing window back for one that's waiting to take over.
  app.on('second-instance', () => {
    if (phase !== 'done') focusWindow()
  })
  const windowIcon = join(resourceDir, 'icon.png')
  mainWindow = createWindow(onWindowClose, windowIcon)
  // The Start Menu shortcut is a COM call that held up every start of the packaged app before the window: written once
  // the page has loaded instead, long before any notification needs it.
  mainWindow.webContents.once('did-finish-load', () => ensureStartMenuShortcut(join(resourceDir, 'icon.ico')))
  reportViewSize(() => (mainWindow ? { width: mainWindow.getContentSize()[0], height: mainWindow.getContentSize()[1] } : null))
  registerViewIpc((sender) => sender === mainWindow?.webContents)
  mainWindow.on('focus', () => notifier.windowFocused())
  // Windows is signing out or shutting down, and won't wait for the usual quit: the canvas is written now, whole.
  mainWindow.on('session-end', () => {
    try {
      docStore.flushSync()
    } catch (e) {
      log?.write(`Saving the canvas as Windows ended the session failed: ${String(e)}`)
    }
  })
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow(onWindowClose, windowIcon)
  })

  tray = new Tray(join(resourceDir, 'tray.png'))
  tray.on('click', focusWindow)
  let shownTray = ''
  let shownAttention = ''
  const refreshTray = (): void => {
    const state = currentTrayState()
    const attention = state.attention.join()
    if (attention !== shownAttention) {
      const before = shownAttention ? shownAttention.split(',').length : 0
      shownAttention = attention
      broadcast('pb:onAttention', state.attention)
      if (before !== state.attention.length) {
        const count = state.attention.length
        const badge = badgeFile(count)
        tray?.setImage(join(resourceDir, count ? 'tray-alert.png' : 'tray.png'))
        mainWindow?.setOverlayIcon(badge ? nativeImage.createFromPath(join(resourceDir, badge)) : null, count ? `${count} to look at` : '')
      }
    }
    const labels = quitMenuLabels(state.running, host.info())
    const trayKey = `${state.summary}|${labels.quit}`
    if (trayKey === shownTray) return
    shownTray = trayKey
    tray?.setToolTip(`Patchbay: ${state.summary}`)
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: state.summary, enabled: false },
        { type: 'separator' },
        { label: 'Open Patchbay', click: focusWindow },
        { label: labels.quit, click: () => quitWith(host.info().mode === 'in-process' ? 'stop-all' : 'leave-running') },
        ...(labels.stopAll ? [{ label: labels.stopAll, click: () => quitWith('stop-all') }] : [])
      ])
    )
  }
  refreshTray()
  setInterval(() => (noteWork('tray refresh'), refreshTray()), TRAY_REFRESH_MS).unref()
  // So the badge goes up with the chime, not at the next refresh.
  tracker.onChange(refreshTray)
  host.onExit(() => refreshTray())
  notifier.onUnseenChange(refreshTray)
  getAttention = () => currentTrayState().attention

  const askAboutOtherHost = async (): Promise<void> => {
    const info = host.info()
    if (info.mode !== 'other-version' || !mainWindow) return
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'An older session host is running',
      message: info.problem ?? 'A session host from another version of Patchbay is still running.',
      detail: "Nothing has been stopped. Stopping them ends those sessions: Claude nodes resume their conversations, and terminals come back as new shells below their saved output. Quitting leaves them running, so you can finish in the older version first. You can also decide later, in Settings under Background sessions.",
      buttons: ['Decide later', 'Stop them and continue', 'Quit and leave them running'],
      defaultId: 0,
      cancelId: 0
    })
    if (response === 1) await resolveOtherHost('stop-it')
    if (response === 2) await resolveOtherHost('quit')
  }
  void askAboutOtherHost()

  // A host started at boot may still be coming up, and only then is it known whether it did.
  void (hostAtBoot.mode === 'starting' ? host.connect() : Promise.resolve(hostAtBoot)).then((atBoot) => {
    if (atBoot.mode !== 'in-process' || !mainWindow) return
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: "Sessions won't keep running",
      message: atBoot.problem ?? "Patchbay couldn't start its background session host.",
      detail: 'Everything else works as usual. Your canvas is safe, Claude nodes resume their conversations, and terminals start again below their saved output. Patchbay tries the host again next time it opens.'
    })
  })

  // A banner with Bring them back, rather than a native dialog. See appProblems.ts.
  host.onLost(() => problems.hostLost())

  if (store.loaded.quarantined) {
    const from = store.loaded.recoveredFrom === 'backup' ? 'the backup copy' : 'an empty canvas'
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Patchbay recovered your canvas',
      message: `The save file was damaged, so Patchbay opened ${from}.`,
      detail: `The damaged file was kept at ${store.loaded.quarantined}.`
    })
  }
}

app.setName('Patchbay')
// --user-data-dir must keep working, so tests and screenshots never touch real data.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), DEV_COPY ? 'Patchbay-dev' : 'Patchbay'))
}
app.setAppUserModelId(DEV_COPY ? `${APP_ID}.dev` : APP_ID)

function exitingFile(): string {
  return join(app.getPath('userData'), 'exiting.json')
}

/** Tells a launch that comes straight after this one to wait for the lock, not give up. */
function markExiting(): void {
  try {
    writeFileSync(exitingFile(), JSON.stringify({ pid: process.pid, at: Date.now() } satisfies ExitingMark))
  } catch (e) {
    console.error('Patchbay could not note that it is exiting:', e)
  }
}

function readExiting(): ExitingMark | null {
  try {
    const mark = JSON.parse(readFileSync(exitingFile(), 'utf8')) as ExitingMark
    return typeof mark.pid === 'number' && typeof mark.at === 'number' ? mark : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Two processes must never write one save file. The first gets a second-instance event and comes forward. */
async function takeInstanceLock(): Promise<boolean> {
  const deadline = Date.now() + EXITING_WAIT_MS
  for (;;) {
    const decision = decideInstance(app.requestSingleInstanceLock(), readExiting(), Date.now(), isAlive)
    if (decision !== 'wait') return decision === 'run'
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

void takeInstanceLock().then((ours) => {
  if (!ours) return app.exit(0)
  rmSync(exitingFile(), { force: true })
  void app.whenReady().then(boot).catch((e: unknown) => {
    dialog.showErrorBox('Patchbay couldn\'t start', String(e))
    app.exit(1)
  })
})

// The window hides rather than closes. It only really closes as the app exits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
