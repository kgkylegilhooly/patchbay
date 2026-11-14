import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, safeStorage, session, shell, Tray, type Event as ElectronEvent } from 'electron'
import { createDocStore } from '../core/persist/docStore'
import { createScrollbackStore } from '../core/persist/scrollbackStore'
import type { AgentStatus } from '../shared/model'
import { createAppStore, type AppStore } from './appStore'
import { createBrowserDriver } from './browser/driver'
import { createAfterGate } from './control/after'
import { loadOrCreateSecret, startControlServer, type ControlServer } from './control/server'
import { createSendQueue } from './control/sendQueue'
import { createVerbs } from './control/verbs'
import { createWhiteboardExporter } from './whiteboardExport'
import { createTriggerService } from './triggers/service'
import { broadcast, registerIpc } from './ipc'
import { createGithubReader, registerWorkIpc, workServices } from './workIpc'
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
import { guardExit, lastHostLogLine, spawnSessionHost } from './sessions/hostSpawn'
import { missedHooksDir, takeMissedHooks } from './sessions/missedHooks'
import { createNodeRunner } from './sessions/nodeRunner'
import { createStatusTracker } from './sessions/statusTracker'
import { createPortWatcher, readConsoleMembers, runNetstat, runProcessList } from './ports/ports'
import { readPage } from './usage/pageSource'
import { createUsageSecret } from './usage/usageSecret'
import { createUsageService } from './usage/usageService'
import { readClaudeAccount, readCodexUsage } from './usage/agentAccounts'
import { sendToAgent } from './agentMessages'
import { setEnvNotPassed } from './sessions/env'
import { autoUpdater } from 'electron-updater'
import { createUpdates, type Updater } from './updates'
import { resolveClaude, type ClaudeProgram } from './sessions/claudeLaunch'
import { resolveCodex } from './sessions/codexLaunch'

/** How often Codex's limits and the accounts are asked for again. */
const AGENT_USAGE_EVERY_MS = 5 * 60_000
/** A moment after launch, so starting up isn't slowed, then a few times a day. */
const UPDATE_FIRST_CHECK_MS = 30_000
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000
import { createUsagePoller, fetchEndpoint, sourceConfig, type ReadResult, type SourceConfig } from './usage/usageSource'

let mainWindow: BrowserWindow | null = null
/** Held here because Electron removes a tray icon that's been collected. */
let tray: Tray | null = null

/** How often the tray catches up. Sessions start and stop in several places, and this is cheap. */
const TRAY_REFRESH_MS = 1500
const APP_ID = 'local.patchbay.app'
const PORT_CHECK_MS = 5000
/** A hook that read the old endpoint just before this launch's was written can still land in a journal. */
const LATE_JOURNAL_CHECK_MS = 3000

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

function createWindow(onClose: (e: ElectronEvent) => void, icon: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0e0e10',
    title: 'Patchbay',
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
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  // Links open through openTerminalLink. Nothing else may take over the window that holds the canvas.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', onClose)
  win.on('focus', () => win.flashFrame(false))
  win.on('closed', () => {
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
  const currentSettings = () => parseSettings(readIfPresent(settingsFile))
  setEnvNotPassed(() => currentSettings().envNotPassed)
  ensureStartMenuShortcut(join(resourceDir, 'icon.ico'))

  let saveErrorShown = false
  const docStore = createDocStore(dataDir, {
    onSaveError(e) {
      console.error('Patchbay autosave failed:', e)
      if (saveErrorShown) return
      saveErrorShown = true
      dialog.showErrorBox('Patchbay can\'t save', `Your canvas could not be written to ${dataDir}. It retries with each change.\n\n${String(e)}`)
    }
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
      if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true)
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
  const host = createBackgroundHost({
    pipe: pipeNameFor(dataDir),
    secret: loadOrCreateSecret(join(controlDir, 'host-secret')),
    // Only acceptance runs set this, to act out an update between two launches.
    protocol: Number(process.env.PATCHBAY_HOST_PROTOCOL) || undefined,
    spawnHost: () => spawnSessionHost({ mainDir: __dirname, dataDir, version: app.getVersion() }),
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
  const runner = createNodeRunner({
    host,
    tracker,
    store,
    approvals,
    ctx: {
      sessionDir: join(dataDir, 'sessions'),
      hookScript: join(resourceDir, 'hook.cjs'),
      statusLineScript: join(resourceDir, 'statusline.cjs'),
      pluginDir: join(resourceDir, 'skill'),
      cliDir: join(resourceDir, 'cli'),
      endpointFile,
      secret,
      settings: currentSettings,
      takeMissedHooks: (id) => takeMissedHooks(journalDir, id)
    }
  })
  const usage = createUsageService({ dataDir })
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
  const browser = createBrowserDriver({ dataDir, store, push: (id, state) => broadcast('pb:onBrowserState', id, state) })
  browser.install()
  const work = workServices()
  const github = createGithubReader(store, work.git, work.gh)
  // One line into each session, shared by `patchbay send` and triggers.
  const sendQueue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id) })
  const whiteboards = createWhiteboardExporter({ dir: join(dataDir, 'whiteboards'), render: renderWhiteboard })
  const verbs = createVerbs({ browser, store, runner, tracker, host, gate, queue: sendQueue, github, whiteboards, defaultAgent: () => (currentSettings().defaultAgent === 'codex' ? 'codex' : 'claude') })
  const triggers = createTriggerService({ store, tracker, host, queue: sendQueue })

  // Before anything can report in: a session's hooks need its node to be known, and the first of them might be next.
  const hostAtBoot = await host.connect()
  const adoptLive = (): string[] => {
    const plan = planReconnect(store.get(), host.sessions())
    for (const id of plan.strays) {
      // A session with no node can't be seen or used. After a damaged save, though, the node may be what's missing.
      if (!host.isRunning(id)) host.forget(id)
      else if (!store.loaded.quarantined) void host.kill(id)
    }
    for (const id of plan.adopt) {
      runner.adoptNode(id)
      const kind = store.get().nodes.find((n) => n.id === id)?.kind
      // Claude draws its own screen without the alternate screen, so its mode alone wouldn't show it needs this.
      if (kind === 'claude') host.repaintOnNextResize(id)
      else saver.markDirty(id)
    }
    return plan.adopt
  }
  const adopted = adoptLive()

  const server: ControlServer = await startControlServer({
    secret,
    endpointFile,
    onHook: async (id, payload, signal) => {
      const answer = await runner.handleHook(id, payload, signal)
      if (payload.hook_event_name !== 'SessionStart') return answer
      // An agent learns where it is on the canvas as its session starts. hook.cjs hands this on as context.
      const context = await verbs(id, 'whoami', {}).then((w) => (w as { text?: string }).text, () => undefined)
      return { ...((answer as object | undefined) ?? {}), context }
    },
    onRpc: (caller, verb, args) => verbs(caller, verb, args),
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
  setInterval(() => void portWatcher.tick(), PORT_CHECK_MS).unref()
  let getAttention: () => string[] = () => []
  const testNotification = () => showToast({ title: 'Patchbay', body: 'Notifications are working.', click: focusWindow })
  // The server is up, so from here on hooks are delivered. What came before is in the journals.
  for (const id of adopted) runner.catchUpHooks(id)
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
    for (const id of plan.claude) await runner.startNode(id)
    gate.evaluate()
    return [...plan.terminals, ...plan.claude]
  }

  let ipcHooks: { reattached(ids: string[]): void } = { reattached: () => {} }
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
  const resolveOtherHost = async (choice: 'stop-it' | 'quit'): Promise<void> => {
    if (host.info().mode !== 'other-version') return
    if (choice === 'quit') quitWith('leave-running')
    else await replaceHost()
  }
  ipcHooks = registerIpc({
    dataDir, store, host, runner, tracker, approvals, gate, scrollback, saver, notifier, testNotification, attention: () => getAttention(), usage, usageSecret, usagePoller, ports: portWatcher, browser,
    hostInfo: () => host.info(),
    quit: quitWith,
    stopHost,
    resolveOtherHost,
    triggers,
    launchRunner: join(resourceDir, 'launch-run.cjs'),
    onSettingsSaved: () => keepAwake.update(tracker.all())
  })
  registerWorkIpc({ store, startNode: (id) => runner.startNode(id), git: work.git, gh: work.gh, reader: github })
  ipcMain.handle('pb:sendToAgent', (_e, id: string, text: string) => sendToAgent({ store, status: (i) => tracker.get(i), queue: sendQueue }, id, text))
  host.onInfo((info) => broadcast('pb:onHostInfo', info))

  await startDead()
  // Only now that sessions are back, so a slot that passed while closed is judged against the real state.
  triggers.start()
  usage.setOff(currentSettings().usageSource === 'off')
  usagePoller.start()
  // Codex's limits and both accounts come from asking the programs themselves, which spends no quota.
  const refreshAgents = async (): Promise<void> => {
    if (currentSettings().usageSource === 'off') return
    try {
      usage.setClaudeAccount(await readClaudeAccount(resolveClaude()))
    } catch {
      // No claude on PATH, or it couldn't say. The panel then shows no account line.
    }
    let codex: ClaudeProgram
    try {
      codex = resolveCodex()
    } catch {
      return // Codex isn't installed, so it has no section.
    }
    try {
      usage.setCodex(await readCodexUsage(codex))
    } catch (e) {
      usage.setCodex({ problem: `Codex didn't say its limits: ${(e as Error).message}`, at: Date.now() })
    }
  }
  void refreshAgents()
  const agentTimer = setInterval(() => void refreshAgents(), AGENT_USAGE_EVERY_MS)
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
  const updates = createUpdates({ updater: autoUpdater as unknown as Updater, feed: () => currentSettings().updateFeed, packaged: app.isPackaged })
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
  setInterval(autoCheck, UPDATE_CHECK_EVERY_MS).unref()

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
  mainWindow.on('focus', () => notifier.windowFocused())
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
  setInterval(refreshTray, TRAY_REFRESH_MS).unref()
  // So the badge goes up with the chime, not at the next refresh.
  tracker.onChange(refreshTray)
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

  if (hostAtBoot.mode === 'in-process') {
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: "Sessions won't keep running",
      message: hostAtBoot.problem ?? "Patchbay couldn't start its background session host.",
      detail: 'Everything else works as usual. Your canvas is safe, Claude nodes resume their conversations, and terminals start again below their saved output. Patchbay tries the host again next time it opens.'
    })
  }

  host.onLost(() => {
    if (!mainWindow) return
    void dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Background sessions stopped',
        message: 'The background session host stopped unexpectedly, and its sessions ended with it.',
        detail: 'Their output is kept. Claude nodes can resume their conversations, and terminals can start again below what they showed.',
        buttons: ['Bring them back', 'Not now'],
        defaultId: 0,
        cancelId: 1
      })
      .then(({ response }) => {
        if (response === 0) void replaceHost()
      })
  })

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
  app.setPath('userData', join(app.getPath('appData'), 'Patchbay'))
}
app.setAppUserModelId(APP_ID)

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
