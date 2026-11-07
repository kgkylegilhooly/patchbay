import type { HostInfo } from '../shared/contract'
import { isSessionNode, type AgentStatus, type CanvasDoc, type CanvasNode } from '../shared/model'
import type { Settings } from '../shared/settings'

export interface RestorePlan {
  /** Claude nodes to launch now. One with a session resumes it. */
  claude: string[]
  terminals: string[]
  /** Claude nodes still waiting on --after. The gate picks these up. */
  held: string[]
}

export interface ReconnectPlan extends RestorePlan {
  /** Still running in the host, so they just need joining. */
  adopt: string[]
  /** Run nodes that ended while the app was away. They never start by themselves, so they only report it. */
  finishedRuns: string[]
  /** Terminals and Claude nodes among those to start that ended in the host, which still holds their output. */
  endedInHost: string[]
  /** Sessions in the host with no node on the canvas. */
  strays: string[]
}

/** What each node needs, given what the host was holding when the app connected. */
export function planReconnect(doc: CanvasDoc, hosted: Array<{ id: string; running: boolean }>): ReconnectPlan {
  const base = planRestore(doc)
  const byId = new Map(hosted.map((s) => [s.id, s]))
  const isLive = (id: string): boolean => byId.get(id)?.running ?? false
  const present = new Set(doc.nodes.map((n) => n.id))
  const sessionNodes = doc.nodes.filter(isSessionNode)
  return {
    claude: base.claude.filter((id) => !isLive(id)),
    terminals: base.terminals.filter((id) => !isLive(id)),
    held: base.held.filter((id) => !isLive(id)),
    adopt: sessionNodes.filter((n) => isLive(n.id)).map((n) => n.id),
    finishedRuns: sessionNodes.filter((n) => n.kind === 'run' && byId.has(n.id) && !isLive(n.id)).map((n) => n.id),
    endedInHost: sessionNodes.filter((n) => n.kind !== 'run' && byId.has(n.id) && !isLive(n.id)).map((n) => n.id),
    strays: hosted.filter((s) => !present.has(s.id)).map((s) => s.id)
  }
}

export function planRestore(doc: CanvasDoc): RestorePlan {
  const plan: RestorePlan = { claude: [], terminals: [], held: [] }
  for (const node of doc.nodes) {
    if (node.kind === 'terminal') plan.terminals.push(node.id)
    else if (node.kind === 'claude') (node.after.length > 0 ? plan.held : plan.claude).push(node.id)
  }
  return plan
}

/** Leaves a full-screen program's screen and any styling behind, so the divider is readable. */
const RESET = '\x1b[?1049l\x1b[?25h\x1b[0m'
const DIVIDER = `${RESET}\r\n\x1b[2m--- the old process ended; this is a new shell ---\x1b[0m\r\n`

/**
 * What a restored session shows first. `claude --resume` redraws the conversation itself, and replaying
 * its full-screen output on top would garble it, so only terminals get their saved scrollback.
 */
export function restoreSeed(kind: CanvasNode['kind'], saved: string | null): string | undefined {
  if (kind !== 'terminal' || !saved) return undefined
  return `${saved}${DIVIDER}`
}

export function needsQuitConfirm(doc: CanvasDoc, statuses: Record<string, AgentStatus>): boolean {
  return doc.nodes.some((n) => n.kind === 'claude' && (statuses[n.id] === 'working' || statuses[n.id] === 'needs-you'))
}

/**
 * Closing the window never ends work. With sessions running the app stays in the tray, because it's what notifies
 * you and holds approval buttons. With nothing running there's no reason to stay.
 */
export function closeAction(running: number): 'hide-to-tray' | 'quit' {
  return running > 0 ? 'hide-to-tray' : 'quit'
}

/** The window vanishing with work still going would look like a quit, so the first time says otherwise. */
export function hideNotice(running: number, alreadyShown: boolean): string | null {
  if (alreadyShown) return null
  return `${running} session${running === 1 ? '' : 's'} still running. Patchbay stays in the tray to tell you when one needs you. Its menu can also stop them.`
}

export type QuitIntent = 'leave-running' | 'stop-all'

export interface QuitQuestion {
  title: string
  message: string
  detail: string
  buttons: string[]
  /** What each button means, in order. Null keeps the app open. */
  answers: Array<QuitIntent | null>
  defaultId: number
  cancelId: number
}

/** What to ask before quitting, or null to just go. It says what really happens, which depends on where sessions run. */
export function quitQuestion(intent: QuitIntent, host: Pick<HostInfo, 'mode'>, running: number, claudeBusy: boolean): QuitQuestion | null {
  const inApp = host.mode === 'in-process'
  const busy = claudeBusy ? 'A Claude node is still working or waiting on you. ' : ''
  // Asked for by name, so only a Claude node in the middle of something warrants a second thought.
  if (intent === 'stop-all' && !claudeBusy) return null
  if (intent === 'leave-running' && !inApp && !claudeBusy) return null
  if (intent === 'leave-running' && inApp && running === 0) return null
  if (intent === 'stop-all') {
    return {
      title: 'Stop all sessions and quit?',
      message: `${busy}Stopping ends it now.`,
      detail: 'Every session ends. Claude nodes can resume their conversations when you reopen Patchbay, and terminals come back as new shells below their saved output.',
      buttons: ['Stop all and quit', 'Keep working'],
      answers: ['stop-all', null],
      defaultId: 1,
      cancelId: 1
    }
  }
  if (inApp) {
    return {
      title: 'Quit Patchbay?',
      message: `${busy}${running === 1 ? 'A session is' : `${running} sessions are`} running inside the app, so quitting ends ${running === 1 ? 'it' : 'them'}.`,
      detail: "The background session host isn't available, so nothing can keep running after Patchbay closes. Claude nodes can resume their conversations when you reopen it, and terminals come back as new shells below their saved output.",
      buttons: ['Quit and end sessions', 'Keep working'],
      answers: ['stop-all', null],
      defaultId: 1,
      cancelId: 1
    }
  }
  return {
    title: 'Quit Patchbay?',
    message: `${busy}Quitting leaves it running in the background.`,
    detail: "Patchbay reconnects when you reopen it. Until then you won't be notified, and a permission request waits at Claude's own prompt in its terminal.",
    buttons: ['Quit and leave running', 'Stop all sessions and quit', 'Keep working'],
    answers: ['leave-running', 'stop-all', null],
    defaultId: 2,
    cancelId: 2
  }
}

/** The tray's way out. A label never promises sessions survive if they can't. */
export function quitMenuLabels(running: number, host: Pick<HostInfo, 'mode'>): { quit: string; stopAll: string | null } {
  if (running === 0) return { quit: 'Quit', stopAll: null }
  if (host.mode === 'in-process') return { quit: 'Quit and end all sessions', stopAll: null }
  return { quit: 'Quit (sessions keep running)', stopAll: 'Stop all sessions and quit' }
}

export interface TrayState {
  running: number
  /** The sessions to look at: waiting on you until answered, or having notified you and not been seen since. */
  attention: string[]
  /** One line, for the tooltip and the top of the menu. */
  summary: string
}

export function trayState(doc: CanvasDoc, statuses: Record<string, AgentStatus>, isRunning: (id: string) => boolean, unseen: string[] = []): TrayState {
  const all = doc.nodes.filter(isSessionNode)
  const running = all.filter((n) => isRunning(n.id)).length
  // A finished session stays listed once it has stopped, since it may be its result you need to see.
  const attention = all.filter((n) => (statuses[n.id] === 'needs-you' && isRunning(n.id)) || unseen.includes(n.id)).map((n) => n.id)
  const count = running === 0 ? 'No sessions running' : running === 1 ? '1 session running' : `${running} sessions running`
  return { running, attention, summary: attention.length ? `${count}, ${attention.length} to look at` : count }
}

/** The taskbar badge for this many sessions to look at, or null for none. */
export function badgeFile(count: number): string | null {
  if (count <= 0) return null
  return count > 9 ? 'badge-many.png' : `badge-${count}.png`
}

/** An instance on its way out leaves this, because it can hold the lock for a few seconds after its window has gone. */
export interface ExitingMark {
  pid: number
  at: number
}

/** Longer than the exit guard's 4 s, so a stuck exit is always over before a new launch stops waiting. */
export const EXITING_WAIT_MS = 8000

/**
 * Whether this launch runs. Without the lock, another instance is either running, and should come forward, or
 * exiting, in which case this one waits for it rather than quit with no window: from outside, that looks like
 * Patchbay failing to open.
 */
export function decideInstance(gotLock: boolean, exiting: ExitingMark | null = null, now = Date.now(), alive: (pid: number) => boolean = () => false): 'run' | 'focus-and-quit' | 'wait' {
  if (gotLock) return 'run'
  if (exiting && now - exiting.at < EXITING_WAIT_MS + 2000 && alive(exiting.pid)) return 'wait'
  return 'focus-and-quit'
}

const SETTING_KEYS = ['shell', 'permissionMode', 'claudeTerminal', 'claudeCommand', 'codexCommand', 'codexApproval', 'defaultAgent', 'updateFeed', 'updateCheck', 'envNotPassed', 'notifications',
  'sound', 'keepAwake'] as const

/** A settings file that can't be read means defaults: it must never stop the canvas from opening. */
export function parseSettings(text: string | null): Settings {
  if (text === null) return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  const fields = (raw ?? {}) as Record<string, unknown>
  const settings: Settings = {}
  for (const key of SETTING_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) settings[key] = value.trim()
  }
  return settings
}

/**
 * The file's new text, keeping any fields Patchbay doesn't know. Null when the current file can't be
 * read as settings, because saving over it would lose whatever was being edited by hand.
 */
export function mergeSettings(text: string | null, next: Settings): string | null {
  let current: Record<string, unknown> = {}
  if (text !== null && text.trim()) {
    try {
      current = JSON.parse(text)
    } catch {
      return null
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
  }
  const merged = { ...current }
  const clean = parseSettings(JSON.stringify(next))
  for (const key of SETTING_KEYS) {
    if (clean[key]) merged[key] = clean[key]
    else delete merged[key]
  }
  return `${JSON.stringify(merged, null, 2)}\n`
}

export interface ScrollbackSaver {
  markDirty(id: string): void
  /** Stops tracking a closed node, so a late write can't bring its file back. */
  forget(id: string): void
  flush(): Promise<void>
  stop(): void
}

/** Writes each dirty node's buffer at most once per interval. */
export function createScrollbackSaver({
  snapshot,
  write,
  intervalMs = 2000
}: {
  snapshot: (id: string) => string
  write: (id: string, data: string) => Promise<void>
  intervalMs?: number
}): ScrollbackSaver {
  const dirty = new Set<string>()

  const flush = async (): Promise<void> => {
    await Promise.all(
      [...dirty].map(async (id) => {
        // Taken before the snapshot: taking one can deliver output, which marks the node dirty again.
        const data = snapshot(id)
        dirty.delete(id)
        try {
          await write(id, data)
        } catch (e) {
          dirty.add(id)
          console.error(`Patchbay could not save scrollback for ${id}:`, e)
        }
      })
    )
  }

  const timer = setInterval(() => void flush(), intervalMs)
  timer.unref?.()

  return {
    markDirty: (id) => void dirty.add(id),
    forget: (id) => void dirty.delete(id),
    flush,
    stop: () => clearInterval(timer)
  }
}
