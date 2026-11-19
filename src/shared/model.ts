import type { Board } from './board'

export type AgentStatus = 'queued' | 'starting' | 'working' | 'idle' | 'needs-you' | 'exited' | 'unknown'

interface Base {
  id: string
  title: string
  /** Relative to the parent group when parentId is set, otherwise absolute. */
  x: number
  y: number
  width: number
  height: number
  parentId: string | null
  /** Set when the node is added: from its group, the node that opened it, or the project on screen. */
  projectId?: string
  color?: string
  openedBy?: string | null
  /** This window's own terminal font size. Without one it follows the global setting. */
  fontSize?: number
}

export interface TerminalNode extends Base {
  kind: 'terminal'
  cwd: string
  command?: string
  /** Set for an SSH terminal: the host or user@host it runs the system's ssh to, in place of a shell. */
  sshHost?: string
  /** The terminal profile it started with, by id, so a restart uses it again. See shared/terminalProfiles.ts. */
  profile?: string
}

/** Which program an agent node runs. Absent means Claude Code, as every node saved before Codex was added. */
export type AgentKind = 'claude' | 'codex'

export const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' }

/** An agent node: Claude Code or Codex. Both report status through the same hooks, so most of Patchbay treats them alike. */
export interface ClaudeNode extends Base {
  kind: 'claude'
  agent?: AgentKind
  cwd: string
  prompt?: string
  sessionId: string | null
  transcriptPath: string | null
  after: string[]
  /** Held for a recipe's setup steps. See src/main/recipes/setupGate.ts. */
  setupWait?: SetupWait
}

/**
 * A recipe agent waiting for its setup. `steps` are the setup run nodes still to exit with code 0, and `after` the
 * starts-after list it's armed with once they have. `failed` is the step that last failed, while it stays failed.
 */
export interface SetupWait {
  steps: string[]
  after: string[]
  recipe: string
  failed?: { step: string; title: string; exitCode: number | null; why: 'exit' | 'stopped' | 'closed' }
}

/** A command run on demand, which never starts by itself on launch. */
export interface RunNode extends Base {
  kind: 'run'
  cwd: string
  command: string
  /** Set for a configuration from .vscode/launch.json. It's read again at each run, and `command` follows from that. */
  launch?: { folder: string; name: string }
}

/** When a trigger fires. Times are local to this PC. */
export type TriggerSchedule = { type: 'cron'; expr: string } | { type: 'interval'; everyMs: number } | { type: 'once'; at: number }

export type TriggerOutcome = 'delivered' | 'queued' | 'missed' | 'failed'

export interface TriggerRun {
  id: string
  at: number
  source: 'schedule' | 'manual'
  outcome: TriggerOutcome
  detail?: string
}

/**
 * Sends a prompt to another session on a schedule. It has no process of its own, and runs in the main process.
 *
 * `armedSpec` is the agreement to fire: the exact schedule, prompt and target the person agreed to, in canonicalSpec's
 * form. It's armed only while that still matches. Only the trigger service sets these four state fields, by the
 * setTriggerState op. Main refuses that op from the page, and no `patchbay` verb can send it.
 */
export interface TriggerNode extends Base {
  kind: 'trigger'
  schedule: TriggerSchedule
  prompt: string
  targetId: string | null
  armedSpec: string | null
  /** When it was armed, which is what interval slots count from. */
  armedAt: number | null
  nextAt: number | null
  /** Newest first. */
  runs: TriggerRun[]
}

/** The part of a trigger that only the trigger service changes. */
export type TriggerState = Pick<TriggerNode, 'armedSpec' | 'armedAt' | 'nextAt' | 'runs'>
export const DISARMED: Pick<TriggerNode, 'armedSpec' | 'armedAt' | 'nextAt'> = { armedSpec: null, armedAt: null, nextAt: null }

export interface StickyNode extends Base {
  kind: 'sticky'
  text: string
}

/** A shape drawn on a whiteboard, in pixels from the top left of its drawing area. */
export type WhiteboardShape =
  | { type: 'pen'; color: string; size: number; points: number[] }
  /** `fill` tints the inside of a rect or ellipse. */
  | { type: 'line' | 'arrow' | 'rect' | 'ellipse'; color: string; size: number; x1: number; y1: number; x2: number; y2: number; fill?: string }
  | { type: 'text'; color: string; size: number; x: number; y: number; text: string }
  /** A pasted picture, saved as a file in app data and named by its content. Every shape has a color and size; a picture doesn't use them. */
  | { type: 'image'; color: string; size: number; x: number; y: number; width: number; height: number; file: string }

/** A board to draw on. Like a note it's layout, and agents linked to it can export it as a picture. */
export interface WhiteboardNode extends Base {
  kind: 'whiteboard'
  shapes: WhiteboardShape[]
}

export interface GroupNode extends Base {
  kind: 'group'
  worktree: { path: string; branch: string; repo: string } | null
}

/** A web page on the canvas. It's not a session: there's no process of its own to start or stop. */
export interface BrowserNode extends Base {
  kind: 'browser'
  /** What it shows, and reloads on the next launch. */
  url: string
  /** The person has taken control, so agent verbs are refused until they hand it back. Kept across restarts. */
  held?: boolean
}

export type CanvasNode = TerminalNode | ClaudeNode | RunNode | StickyNode | WhiteboardNode | GroupNode | BrowserNode | TriggerNode
export type SessionNode = TerminalNode | ClaudeNode | RunNode

export function isSessionNode(n: CanvasNode | undefined): n is SessionNode {
  return n?.kind === 'terminal' || n?.kind === 'claude' || n?.kind === 'run'
}

/** Where a session runs, as shown: `ssh host` for an SSH terminal, since its folder is only where ssh started here. */
export function whereShown(n: SessionNode): string {
  return n.kind === 'terminal' && n.sshHost ? `ssh ${n.sshHost}` : n.cwd
}

export function agentOf(n: { agent?: AgentKind }): AgentKind {
  return n.agent ?? 'claude'
}

export interface Edge {
  id: string
  from: string
  to: string
  kind: 'opened' | 'link' | 'after'
}

export interface ClosedSession {
  id: string
  title: string
  cwd: string
  sessionId: string
  transcriptPath: string | null
  closedAt: number
  projectId?: string
  agent?: AgentKind
}

export type Viewport = { x: number; y: number; zoom: number }

export interface Project {
  /** Explicit outcomes, independent of session status. Absent in older projects. */
  tasks?: import('./task').TaskRecords
  id: string
  name: string
  /** Where new sessions start. Empty means the home folder. */
  folder: string
  /** Where the view was when this project was last left. The project on screen uses CanvasDoc.viewport. */
  viewport: Viewport
  /**
   * When it was closed. A closed project has no tab, but keeps its nodes, and its sessions keep running.
   * Absent means it's open. The project on screen is always open.
   */
  closedAt?: number
  /** The kanban board's columns and where each card sits. Absent until the board is first used. */
  board?: Board
}

export interface CanvasDoc {
  version: 3
  /** Never empty in a loaded doc, in tab order. */
  projects: Project[]
  activeProjectId: string
  /** Every project's nodes. Ids are unique across all of them. Always ordered with parents before children. */
  nodes: CanvasNode[]
  edges: Edge[]
  /** Oldest first, at most the newest 200. */
  closed: ClosedSession[]
  /** The view of the project on screen. */
  viewport: Viewport
}

/** Whether this belongs to the project on screen. */
export function inActiveProject(doc: Pick<CanvasDoc, 'activeProjectId'>, item: { projectId?: string }): boolean {
  return !item.projectId || item.projectId === doc.activeProjectId
}

export function isProjectOpen(project: Pick<Project, 'closedAt'>): boolean {
  return project.closedAt === undefined
}

/** Where a node sits and what it's called: the parts of a node that undo can put back. */
export type NodeLayout = Pick<CanvasNode, 'id' | 'x' | 'y' | 'width' | 'height' | 'parentId' | 'title'>

/**
 * Puts layout back as undo or redo asks. It can only move and rename nodes, and add or remove notes and groups,
 * so it can never end or start a session.
 */
export interface LayoutRestore {
  patches: NodeLayout[]
  add: CanvasNode[]
  remove: string[]
  edges: Edge[]
}

export type CanvasOp =
  | { op: 'setTasks'; projectId: string; tasks: import('./task').TaskRecords }
  | { op: 'addNode'; node: CanvasNode }
  | { op: 'patchNode'; id: string; patch: Partial<CanvasNode> }
  | { op: 'removeNodes'; ids: string[]; at: number }
  /** Takes an entry out of the closed history, as when its conversation is reopened. */
  | { op: 'removeClosed'; id: string }
  | { op: 'addEdge'; edge: Edge }
  | { op: 'removeEdge'; id: string }
  | { op: 'setParent'; ids: string[]; parentId: string | null }
  | { op: 'setViewport'; viewport: CanvasDoc['viewport'] }
  | { op: 'arrange'; ids: string[]; layout: 'grid' | 'row' | 'column'; gap?: number }
  /** Puts each node at a position relative to its parent and fits its group round it. Tidy sends this. */
  | { op: 'moveNodes'; moves: { id: string; x: number; y: number }[] }
  /** Adds it and puts it on screen. */
  | { op: 'addProject'; project: Project }
  | { op: 'patchProject'; id: string; patch: Partial<Pick<Project, 'name' | 'folder'>> }
  /** Showing a closed project reopens it. */
  | { op: 'switchProject'; id: string }
  /** Takes it off the tabs, keeping its nodes and leaving its sessions running. The last open one can't be closed. */
  | { op: 'closeProject'; id: string; at: number }
  /** Removes it and everything in it, for good. The last project can't be removed. */
  | { op: 'removeProject'; id: string; at: number }
  | ({ op: 'restoreLayout' } & LayoutRestore)
  /** Replaces a project's board. Only where cards sit changes: no session is touched. */
  | { op: 'setBoard'; projectId: string; board: Board }
  /** Only for the trigger service. Main refuses it from the page. */
  | { op: 'setTriggerState'; id: string; state: Partial<TriggerState> }
