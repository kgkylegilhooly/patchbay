import type { LaunchItem } from './launch'
import type { AgentStatus, CanvasDoc, CanvasOp, TriggerRun } from './model'

export type Refusal = { ok: false; reason: string }

export interface LaunchListing {
  ok: true
  file: string
  /** A runnable configuration also says the command line it would run, and where. */
  items: Array<LaunchItem & { command?: string; cwd?: string }>
}
import type { Settings } from './settings'
import type { UsageState } from './usage'
import type { DesignPick } from './design'

export interface NodeError {
  code: 'cwd-missing' | 'spawn-failed' | 'resume-failed'
  message: string
}

/** Where an update stands. */
export type UpdateState =
  | { phase: 'off'; reason: string }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none'; checkedAt: number }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

export interface PendingApproval {
  nodeId: string
  requestId: string
  tool: string
  summary: string
}

/** Task 10 implements this. Tests use an in-memory one over reduce. */
export interface CanvasStore {
  get(): CanvasDoc
  dispatch(op: CanvasOp): void
  subscribe(cb: (d: CanvasDoc) => void): () => void
}

export interface SessionSpec {
  nodeId: string
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  initialScrollback?: string
  /** The host keeps this session's saved scrollback current while no app is connected. */
  saveScrollback?: boolean
}

/**
 * The seam around sessions. Nothing outside the session layer may assume a PTY lives in this process: the usual
 * implementation is a mirror of a background host, so `start` takes time and everything else answers from the mirror.
 */
export interface SessionHost {
  /** Fails with SessionStartError (Task 3) when the session can't start. Counts as running from the moment it's called. */
  start(spec: SessionSpec): void | Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): Promise<void>
  /** The session's root process while it's running. */
  pid(id: string): number | null
  isRunning(id: string): boolean
  snapshot(id: string): { data: string; seq: number }
  onOutput(cb: (id: string, data: string, seq: number) => void): void
  onExit(cb: (id: string, code: number) => void): void
  /** Drops what's kept of an ended session whose node has closed. */
  forget?(id: string): void
}

export interface HostInfo {
  /**
   * background: sessions run in the host and outlive the app. in-process: no host could be used, so they end with it.
   * other-version: a host this app can't talk to is holding sessions, and the owner has to choose. stopped: no host
   * right now, and the next session starts one.
   */
  mode: 'starting' | 'background' | 'in-process' | 'other-version' | 'stopped'
  running: number
  expectedProtocol: number
  /** Why it isn't in the ordinary state, in words for the owner. */
  problem?: string
  pid?: number
  version?: string
  protocol?: number
  startedAt?: number
}

export interface RunResult {
  running: boolean
  /** Null until it has ended. */
  exitCode: number | null
  /** Stop or Ctrl+C ended it, so its exit isn't a failure. */
  stoppedByYou: boolean
  at: number
}

export interface PortInfo {
  port: number
  /** The program listening on it. */
  name: string
}

/** What a browser node's page is doing now. Only held while it's on screen, and none of it is saved. */
export interface BrowserState {
  url: string
  /** Set by the page, so it's only for showing as plain text. */
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** The last thing refused or blocked on this page, to explain why nothing happened. */
  notice: string | null
  /** The agent that last acted here and what it did. Typed text is never part of it. */
  driving: { by: string; action: string; at: number } | null
}

export type BrowserStep = 'back' | 'forward' | 'reload' | 'stop'

export interface PatchbayBridge {
  /** Tells main which page belongs to which node, once the canvas has drawn it. */
  browserAttached(nodeId: string, contentsId: number): Promise<void>
  browserNavigate(nodeId: string, address: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }>
  browserStep(nodeId: string, step: BrowserStep): Promise<void>
  /** Design mode: resolves when the person picks an element in the page, or with null if they cancel. */
  browserPick(nodeId: string): Promise<{ ok: true; pick: DesignPick | null } | { ok: false; reason: string }>
  browserCancelPick(nodeId: string): Promise<void>
  getBrowserStates(): Promise<Record<string, BrowserState>>
  onBrowserState(cb: (id: string, state: BrowserState | null) => void): () => void
  /** Opens a port a session is serving in a new browser node beside it. False if it isn't listed for that node. */
  openPortInBrowser(nodeId: string, port: number): Promise<boolean>
  getDoc(): Promise<CanvasDoc>
  dispatch(op: CanvasOp): Promise<void>
  onDoc(cb: (d: CanvasDoc) => void): () => void
  getStatuses(): Promise<Record<string, AgentStatus>>
  /** null means the node has no status to show, as with a terminal that's running. */
  onStatus(cb: (id: string, s: AgentStatus | null) => void): () => void
  getErrors(): Promise<Record<string, NodeError>>
  onNodeError(cb: (id: string, e: NodeError | null) => void): () => void
  attach(id: string): Promise<{ data: string; seq: number }>
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onOutput(cb: (id: string, data: string, seq: number) => void): () => void
  /** A launch.json run that can't run as its file now says gives back the reason, and nothing starts. */
  startNode(id: string): Promise<void | Refusal>
  restartNode(id: string): Promise<void | Refusal>
  /** Arms exactly the spec that was shown. Refused if the trigger has changed since, or isn't complete. */
  armTrigger(id: string, shownSpec: string): Promise<{ ok: true } | Refusal>
  disarmTrigger(id: string): Promise<void>
  /** Fires an armed trigger now, sending what's saved on it. */
  runTriggerNow(id: string): Promise<{ ok: true; run: TriggerRun } | Refusal>
  /** Only reads the file. Nothing in it runs until a run node's Run is clicked. */
  readLaunchConfigs(folder: string): Promise<LaunchListing | Refusal>
  /** The hosts named in ~/.ssh/config, the folder an SSH terminal starts from, and whether ssh is installed. */
  listSshHosts(): Promise<{ hosts: string[]; home: string; installed: boolean }>
  createWorktree(groupId: string, a: { repo: string; branch: string }): Promise<void>
  removeWorktree(groupId: string): Promise<{ ok: true } | { ok: false; reason: string }>
  unbindWorktree(groupId: string): Promise<void>
  pickFolder(): Promise<string | null>
  /** A program to run, chosen in the file dialog. */
  pickProgram(): Promise<string | null>
  openSettingsFile(): Promise<void>
  /** Exits and leaves sessions running in the background, asking first if a Claude node is busy. Closing the window only hides it. */
  quitApp(): Promise<void>
  /** Ends every session and the background host, then exits, asking first if a Claude node is busy. */
  stopAllAndQuit(): Promise<void>
  getHostInfo(): Promise<HostInfo>
  onHostInfo(cb: (info: HostInfo) => void): () => void
  /** Ends every session and the background host. The app stays open, and the next session starts a new one. */
  stopHost(): Promise<void>
  /** Answers the question of a host from another version: end it and carry on, or quit and leave it running. */
  resolveOtherHost(choice: 'stop-it' | 'quit'): Promise<void>
  /** Main brought these sessions back from nothing, so their views should be rebuilt. */
  onReattach(cb: (ids: string[]) => void): () => void
  /** Sends a real Windows notification and says what Windows did with it. */
  testNotification(): Promise<'shown' | 'failed' | 'unsupported'>
  /** Main asks for the chime, when a session needs you. */
  onChime(cb: () => void): () => void
  getRuns(): Promise<Record<string, RunResult>>
  onRun(cb: (id: string, run: RunResult) => void): () => void
  stopRun(id: string): Promise<void>
  getPorts(): Promise<Record<string, PortInfo[]>>
  onPorts(cb: (ports: Record<string, PortInfo[]>) => void): () => void
  /** False if that port isn't currently listed for that node. */
  openPort(nodeId: string, port: number): Promise<boolean>
  getUsage(): Promise<UsageState>
  /** Reads the usage source now, and updates the pill. */
  testUsageSource(): Promise<{ ok: true; used: number; limit: number } | { ok: false; problem: string }>
  /** Only whether one is saved ever comes back. The header itself stays in main. */
  hasUsageSecret(): Promise<boolean>
  setUsageSecret(header: string): Promise<{ ok: true } | { ok: false; problem: string }>
  removeUsageSecret(): Promise<void>
  /** Opens the configured page visibly, on the saved sign-in the page source uses. Says why if it can't. */
  openUsageSignIn(): Promise<string | null>
  onUsage(cb: (usage: UsageState) => void): () => void
  /** The sessions to look at, which is what the taskbar badge counts. */
  getAttention(): Promise<string[]>
  onAttention(cb: (ids: string[]) => void): () => void
  markSeen(id: string): void
  openDataFolder(): Promise<void>
  getAppInfo(): Promise<{ version: string; dataDir: string }>
  getSettings(): Promise<Settings>
  /** Applies to sessions started from now on. */
  saveSettings(settings: Settings): Promise<{ ok: true } | { ok: false; reason: string }>
  getApprovals(): Promise<PendingApproval[]>
  onApprovals(cb: (a: PendingApproval[]) => void): () => void
  answerApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  savePastedImage(bytes: Uint8Array, mime: string): Promise<string>
  openTerminalLink(nodeId: string, target: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** The full path a terminal path means, against the node's folder, and the folder a terminal there would use. */
  resolveTerminalPath(nodeId: string, target: string): Promise<{ ok: true; path: string; folder: string } | { ok: false; reason: string }>
  revealTerminalPath(nodeId: string, target: string): Promise<{ ok: true } | { ok: false; reason: string }>
  getUpdateState(): Promise<UpdateState>
  onUpdateState(cb: (s: UpdateState) => void): () => void
  checkForUpdates(): Promise<void>
  /** Ends every session, installs the downloaded update and starts the new version. */
  restartToUpdate(): Promise<void>
  /** An agent window's conversation, newest last, for its chat view. */
  readConversation(nodeId: string): Promise<{ ok: true; messages: Array<{ role: 'user' | 'assistant'; text: string }> } | { ok: false; reason: string }>
  /** The person's own message to an agent window. A busy agent gets it once it's idle. */
  sendToAgent(nodeId: string, text: string): Promise<{ ok: true; queued: boolean } | { ok: false; reason: string }>
  reopenClosed(closedId: string): Promise<void>
  readClosedTranscript(closedId: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
  /** Which node's terminal has the keyboard, so a notification can skip the node being watched. */
  noteFocus(id: string | null): void
  /** Main asks for a node to be centered, as when its notification is clicked. */
  onCenterNode(cb: (id: string) => void): () => void
  /** When each session last did something, since the app started. A session with no entry shows no time. */
  getActivity(): Promise<Record<string, number>>
  onActivity(cb: (id: string, at: number) => void): () => void
  /** Asks Claude for a title from the session's recent output. Spends a little plan quota, so it's only run on a click. Doesn't apply it. */
  nameWithAi(id: string): Promise<{ ok: true; title: string } | { ok: false; reason: string }>
}
