import type { LaunchItem } from './launch'
import type { AgentStatus, CanvasDoc, CanvasOp, TriggerRun, WhiteboardShape } from './model'

export type Refusal = { ok: false; reason: string }
/** A launch.json run that asks first (LJ1): `approvePlan` names the plan the reason shows, for Run it to agree to. */
export type PlanQuestion = Refusal & { approvePlan: string }

export interface LaunchListing {
  ok: true
  file: string
  /** A runnable configuration also says the command line it would run, and where. */
  items: Array<LaunchItem & { command?: string; cwd?: string; approve?: string }>
}
import type { Settings } from './settings'
import type { UsageState } from './usage'
import type { DesignPick } from './design'

export interface NodeError {
  code: 'cwd-missing' | 'spawn-failed' | 'resume-failed'
  message: string
  /** What the person can do about a start that failed, offered as a button on the node. See docs/plans/r3-start.md. */
  fix?: StartFix
}

/**
 * agents: Settings › Agents. sessions: Settings › Background sessions. folder: choose another folder. memory: it waits
 * for memory, and Start now starts it anyway.
 */
export type StartFix = 'agents' | 'sessions' | 'folder' | 'memory'

/** Where an update stands. */
export type UpdateState =
  | { phase: 'off'; reason: string }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none'; checkedAt: number }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  /** `install`: Restart to update couldn't install, rather than a check or download failing. The message says so itself. */
  | { phase: 'error'; message: string; install?: true }

export interface PendingApproval {
  nodeId: string
  requestId: string
  tool: string
  summary: string
  /** The same text without the cut, for when the person asks to see all of it. */
  detail: string
  /**
   * The whole request, tool and input, as one value: equal only for the very same request. `detail` is display text,
   * the path alone for an Edit or Write, so it can't say two requests are the same. Used by Approve all N.
   */
  same: string
  /** Claude's own "don't ask again" rule for this call, when it offered one Patchbay passes on: see approvals.ts. */
  always?: { rule: string; where: string }
}

/** How the person answers a permission request. `allow-always` also adds the rule in `PendingApproval.always`. */
export type ApprovalChoice = 'allow' | 'deny' | 'allow-always'

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
  /**
   * Runs below normal priority, as do the programs it starts, since Windows hands that on. Busy agents on a PC with few
   * cores took the CPU the window and terminals needed, and a key took over a second to show. With spare CPU, nothing
   * changes: they still get all of it.
   */
  background?: boolean
  /** The port its hooks post to, which must be the connected session host's. See docs/plans/host-hooks.md. */
  hookPort?: number
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
  /** `tree`: also everything its processes started (Stop on a run). See docs/plans/r5-jobkill.md. */
  kill(id: string, opts?: { tree?: boolean }): Promise<void>
  /** The session's root process while it's running. */
  pid(id: string): number | null
  isRunning(id: string): boolean
  snapshot(id: string): { data: string; seq: number }
  onOutput(cb: (id: string, data: string, seq: number) => void): void
  onExit(cb: (id: string, code: number) => void): void
  /** Drops what's kept of an ended session whose node has closed. */
  forget?(id: string): void
  /** The sessions some window shows, or null if that isn't known. The rest may send output in bigger, rarer pieces. */
  setShown?(ids: ReadonlySet<string> | null): void
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
  /** How many recorded checks there are. The checks themselves are fetched with browserEvidence when shown. */
  evidence?: import('./browserEvidence').EvidenceSummary
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
  /** The latest load failed: what to show in the page's place. See browserFailure.ts. */
  failure?: import('./browserFailure').BrowserFailure | null
}

export type BrowserStep = 'back' | 'forward' | 'reload' | 'stop'

/** A message one node sent another with `patchbay send`. The text is as written, without the line naming the sender. */
export interface NodeMessage {
  from: string
  to: string
  text: string
  at: number
}

/** Shapes an agent drew on a whiteboard: the board had `before` shapes, and the agent's are the ones after them. */
export interface BoardEdit {
  id: string
  by: string
  before: number
  after: number
  at: number
}

/** Agents' changes still showing on notes and boards, oldest first. */
export interface AgentEdits {
  notes: NoteEdit[]
  boards: BoardEdit[]
}

/** An agent's change to a note, with the text from before it, so the person can undo it. */
export interface NoteEdit {
  id: string
  by: string
  before: string
  after: string
  at: number
}

export interface PatchbayBridge {
  taskShow(projectId: string, taskId: string): Promise<import('./task').TaskView>
  taskAccept(projectId: string, taskId: string, submissionId: string): Promise<import('./task').Task>
  /** Tells main which page belongs to which node, once the canvas has drawn it. */
  browserAttached(nodeId: string, contentsId: number): Promise<void>
  browserNavigate(nodeId: string, address: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }>
  browserStep(nodeId: string, step: BrowserStep): Promise<void>
  /** Design mode: resolves when the person picks an element in the page, or with null if they cancel. */
  browserPick(nodeId: string): Promise<{ ok: true; pick: DesignPick | null } | { ok: false; reason: string }>
  browserCancelPick(nodeId: string): Promise<void>
  getBrowserStates(): Promise<Record<string, BrowserState>>
  browserEvidenceImage(nodeId: string, attemptId: string, index: number): Promise<string | null>
  /** A browser node's recorded checks, newest first. */
  browserEvidence(nodeId: string): Promise<import('./browserEvidence').BrowserAttempt[]>
  onBrowserState(cb: (id: string, state: BrowserState | null) => void): () => void
  /** Opens a port a session is serving in a new browser node beside it. False if it isn't listed for that node. */
  openPortInBrowser(nodeId: string, port: number): Promise<boolean>
  /** The whole doc, whiteboard shapes included. */
  getDoc(): Promise<CanvasDoc>
  dispatch(op: CanvasOp): Promise<void>
  /** Each change to the doc. Whiteboards come with no shapes: those arrive by onBoardShapes, and only when they change. */
  onDoc(cb: (d: CanvasDoc) => void): () => void
  /** A whiteboard's shapes, sent before the doc that changed them. */
  onBoardShapes(cb: (id: string, shapes: WhiteboardShape[]) => void): () => void
  getStatuses(): Promise<Record<string, AgentStatus>>
  /** null means the node has no status to show, as with a terminal that's running. */
  onStatus(cb: (id: string, s: AgentStatus | null) => void): () => void
  getErrors(): Promise<Record<string, NodeError>>
  onNodeError(cb: (id: string, e: NodeError | null) => void): () => void
  attach(id: string): Promise<{ data: string; seq: number }>
  input(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onOutput(cb: (id: string, data: string, seq: number) => void): () => void
  /**
   * The sessions whose output this window shows. Others' output isn't sent to it, as for windows in another project's
   * tab. Until a window says, it gets every session's. Sent before attaching, so nothing in between is missed.
   */
  watchOutput(ids: string[]): void
  /** Run from source, with data of its own, apart from an installed copy. */
  devCopy: boolean
  /** A launch.json run that can't run as its file now says gives back the reason, and nothing starts. */
  startNode(id: string): Promise<void | Refusal | PlanQuestion>
  /** `shownExited`: the window showed it as ended, so a session found still running is shown again, never ended. */
  /** `acceptPlan`: the person agreed to the launch.json plan a PlanQuestion showed. Only that exact plan runs. */
  restartNode(id: string, opts?: { shownExited?: boolean; pastMemory?: boolean; acceptPlan?: string }): Promise<void | Refusal | PlanQuestion>
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
  /** F62: the key from anywhere was pressed, and the window brought forward. */
  onGlobalKey(cb: () => void): () => void
  /** Whether the key from anywhere is set and working, and why not. */
  globalKeyState(): Promise<{ key: string | null; ok: boolean; reason?: string }>
  getRuns(): Promise<Record<string, RunResult>>
  onRun(cb: (id: string, run: RunResult) => void): () => void
  /** Runs a run command N times, counting failures (F64). */
  startRunSeries(id: string, times: number): Promise<{ ok: true } | { ok: false; reason: string }>
  onRunSeries(cb: (id: string, state: import('./runSeries').SeriesState | null) => void): () => void
  stopRun(id: string): Promise<void>
  getPorts(): Promise<Record<string, PortInfo[]>>
  onPorts(cb: (ports: Record<string, PortInfo[]>) => void): () => void
  /** A run or terminal failed on a port that's taken (F68), or null once it starts again or the strip is dismissed. */
  onPortInUse(cb: (id: string, state: import('./portInUse').PortInUse | null) => void): () => void
  dismissPortInUse(id: string): Promise<void>
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
  /** Puts text on the clipboard through Electron, which works where the page's own clipboard is refused. */
  writeClipboard(text: string): Promise<void>
  /** Opens the log of hangs, crashes and stalls, in the data folder's logs folder. */
  openLog(): Promise<void>
  /** Notes in the log that the window was held up for this long, and by what if known. */
  noteSlow(ms: number, what?: string): void
  getAppInfo(): Promise<{ version: string; dataDir: string }>
  getSettings(): Promise<Settings>
  /** Why an agent of this kind (the default one, with none) won't start because its program isn't found, or null. */
  agentProgramProblem(kind?: 'claude' | 'codex'): Promise<string | null>
  /** Applies to sessions started from now on. */
  saveSettings(settings: Settings): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Pause all triggers on or off (F54), leaving every other setting as it is. */
  setTriggersPaused(on: boolean): Promise<{ ok: true } | { ok: false; reason: string }>
  getApprovals(): Promise<PendingApproval[]>
  onApprovals(cb: (a: PendingApproval[]) => void): () => void
  answerApproval(requestId: string, choice: ApprovalChoice): Promise<void>
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
  /**
   * An agent window's conversation, newest last, for its chat view: the last `limit` messages (a page of 200 when not
   * given; see shared/conversation.ts), and whether there are earlier ones. With `since`, the version of the last answer,
   * an answer that would be the same comes back as `unchanged`.
   */
  readConversation(nodeId: string, limit?: number, since?: string): Promise<import('./conversation').ConversationAnswer>
  /** The person's own message to an agent window. A busy agent gets it once it's idle. */
  sendToAgent(nodeId: string, text: string): Promise<{ ok: true; queued: boolean } | { ok: false; reason: string }>
  reopenClosed(closedId: string): Promise<void>
  /** A closed terminal or run, by its node id, reopened with its saved output (F48). */
  reopenShell(id: string): Promise<void>
  readClosedTranscript(closedId: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
  /** Which node's terminal has the keyboard, so a notification can skip the node being watched. */
  noteFocus(id: string | null): void
  /** Main asks for a node to be centered, as when its notification is clicked. */
  onCenterNode(cb: (id: string) => void): () => void
  /** One node sent another a message with `patchbay send`. */
  onMessage(cb: (message: NodeMessage) => void): () => void
  /** The messages sent between nodes since the app started, newest last. */
  getMessages(): Promise<NodeMessage[]>
  /** An agent changed a note with `patchbay note`. */
  onNoteEdit(cb: (edit: NoteEdit) => void): () => void
  /** An agent drew on a whiteboard with `patchbay draw`. */
  onBoardEdit(cb: (edit: BoardEdit) => void): () => void
  /** Agents' changes the person hasn't kept or undone yet, kept across restarts. */
  getAgentEdits(): Promise<AgentEdits>
  /** The person kept or undid the agents' changes to a note or board. */
  settleAgentEdits(id: string): void
  /** When each session last did something, since the app started. A session with no entry shows no time. */
  getActivity(): Promise<Record<string, number>>
  onActivity(cb: (id: string, at: number) => void): () => void
  /** Main asks for a whiteboard's SVG drawn as a PNG, for an agent's export. The page answers with whiteboardRendered. */
  onRenderWhiteboard(cb: (requestId: string, svg: string, width: number, height: number) => void): () => void
  /** Null if the picture couldn't be made. */
  whiteboardRendered(requestId: string, png: Uint8Array | null): void
  /** Keeps a picture pasted onto a whiteboard, and gives the name the board saves for it. */
  saveBoardImage(bytes: Uint8Array, mime: string): Promise<string>
  /** A board's picture as a data URL, or null if it's gone. */
  readBoardImage(file: string): Promise<string | null>
  /** Asks Claude for a title from the session's recent output. Spends a little plan quota, so it's only run on a click. Doesn't apply it. */
  nameWithAi(id: string): Promise<{ ok: true; title: string } | { ok: false; reason: string }>
}
