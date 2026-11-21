import { pendingToolOf } from '../../core/transcript/peek'
import type { AgentStatus } from '../../shared/model'
import type { SyncProblem, SyncReport, SyncRow } from '../../shared/sessionSync'
import type { HostedSession } from './hostProtocol'

/**
 * A periodic check that the canvas, the app's mirror of each session and the background host agree, and the fixes for
 * when they don't. It never ends a running session by itself. See docs/plans/session-sync.md.
 */

/** Between checks that ask the host and look at processes. Focus and waking ask sooner, but never closer than MIN_GAP_MS. */
export const CHECK_EVERY_MS = 45_000
export const MIN_GAP_MS = 30_000
/** Starting this long with no hook, while its screen is still, means its SessionStart never arrived. */
export const STALE_STARTING_MS = 2 * 60_000
/** Working this long with no hook or tool call, while its screen is still. A long tool call keeps its spinner going. */
export const STALE_WORKING_MS = 10 * 60_000
/** A program waiting at its prompt draws nothing. Claude's spinner redraws several times a second while it works. */
export const OUTPUT_QUIET_MS = 60_000

export interface SyncNodeView {
  id: string
  kind: 'claude' | 'terminal' | 'run'
  title: string
  /** The status the canvas shows: the tracker's for an agent, `exited` for an ended terminal, otherwise null. */
  shown: AgentStatus | null
}

export interface SyncInput {
  nodes: SyncNodeView[]
  /** The app's mirror, after it has been put right against the host's own list. */
  sessions: HostedSession[]
  alive(pid: number): boolean
  now: number
  /** When the canvas last heard anything of its agent: a hook, a tool call, or its status changing. */
  lastHeard(id: string): number | undefined
  /** When the session last printed anything. */
  lastOutput(id: string): number | undefined
}

export interface SyncPlan {
  /** The canvas says ended, the host runs it and its process is there: adopt it and show it again. */
  reattach: string[]
  /** Counted as running with a process that's gone: have the host end its record. */
  gone: string[]
  /** Running with no node. Reported, never ended without asking. */
  orphans: string[]
  /** An agent whose status has been starting or working too long with nothing heard and nothing drawn. */
  stale: string[]
  rows: SyncRow[]
}

/** Pure. Everything it decides is from what it's given, so each case can be tested on its own. */
export function planSync(input: SyncInput): SyncPlan {
  const plan: SyncPlan = { reattach: [], gone: [], orphans: [], stale: [], rows: [] }
  const nodes = new Map(input.nodes.map((n) => [n.id, n]))
  const sessions = new Map(input.sessions.map((s) => [s.id, s]))
  const row = (id: string, node: SyncNodeView | undefined, session: HostedSession | undefined, alive: boolean | null, problem: SyncProblem | null): void => {
    plan.rows.push({ id, title: node?.title ?? null, kind: node?.kind ?? null, running: session?.running ?? false, pid: session?.pid ?? null, alive, shown: node?.shown ?? null, problem })
  }

  for (const session of input.sessions) {
    if (!session.running) continue
    const node = nodes.get(session.id)
    // No pid yet is a start still under way: nothing to judge.
    const alive = session.pid === null ? null : input.alive(session.pid)
    if (alive === false) {
      plan.gone.push(session.id)
      row(session.id, node, session, alive, 'pid-gone')
      continue
    }
    if (!node) {
      plan.orphans.push(session.id)
      row(session.id, node, session, alive, 'orphan')
      continue
    }
    if (node.shown === 'exited' && alive) {
      plan.reattach.push(node.id)
      row(node.id, node, session, alive, 'shown-exited')
      continue
    }
    if (node.kind === 'claude' && alive && isStale(node, input)) {
      plan.stale.push(node.id)
      row(node.id, node, session, alive, 'stale-status')
      continue
    }
    row(node.id, node, session, alive, null)
  }
  // Nodes the canvas shows as running that nothing runs are left to the exit already reported: that's the agreed state.
  for (const node of input.nodes) if (!sessions.has(node.id) && node.shown && node.shown !== 'exited' && node.shown !== 'queued') row(node.id, node, undefined, null, null)
  return plan
}

function isStale(node: SyncNodeView, input: SyncInput): boolean {
  const limit = node.shown === 'starting' ? STALE_STARTING_MS : node.shown === 'working' ? STALE_WORKING_MS : null
  if (limit === null) return false
  const heard = input.lastHeard(node.id)
  if (heard !== undefined && input.now - heard < limit) return false
  const drew = input.lastOutput(node.id)
  return drew === undefined || input.now - drew >= OUTPUT_QUIET_MS
}

/**
 * Pure. What a transcript's end says about a turn whose hooks never arrived: `idle` when its last word is the agent's
 * with no call left waiting, otherwise `unknown`, which claims nothing. Never `working`: that's what went stale.
 */
export function statusFromTranscript(lines: string[] | null): AgentStatus {
  if (!lines?.length) return 'unknown'
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    if ((entry?.type !== 'user' && entry?.type !== 'assistant') || entry.isSidechain || entry.isMeta) continue
    if (entry.type === 'user') return 'unknown'
    const content: unknown = entry.message?.content
    const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown }>) : []
    if (blocks.some((b) => b?.type === 'tool_use')) return 'unknown'
    if (!blocks.some((b) => b?.type === 'text') && typeof content !== 'string') continue
    return pendingToolOf(lines) ? 'unknown' : 'idle'
  }
  return 'unknown'
}

/** Whether a process is there. Asking with signal 0 sends nothing and costs one system call, not a process scan. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it's there, owned by someone this app can't signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface SessionSyncDeps {
  nodes(): SyncNodeView[]
  host: {
    sessions(): HostedSession[]
    /** Puts the mirror right against the host's own list. Null when there's no host to ask. */
    refresh(): Promise<HostedSession[] | null>
    kill(id: string): Promise<void>
  }
  /** Adopts a session again and rebuilds its views. */
  reattach(id: string): void
  /** Reads the end of an agent's transcript, or null if it has none. */
  transcript(id: string): Promise<string[] | null>
  /** Sets a status worked out rather than heard. */
  seed(id: string, status: AgentStatus): void
  /** When the tracker last changed the node's status. */
  since(id: string): number | undefined
  /** When a tool call last touched its signal file. */
  latestSignal?(id: string): number | undefined
  onReport?(report: SyncReport): void
  log?(line: string): void
  alive?(pid: number): boolean
  now?(): number
  minGapMs?: number
}

export interface SessionSync {
  /** Checks unless one ran within the last MIN_GAP_MS, or `force`. Resolves to the latest report. */
  check(reason: string, force?: boolean): Promise<SyncReport | null>
  report(): SyncReport | null
  /** A hook came in for this node. */
  heard(id: string): void
  /** This session printed something. Called for every chunk, so it only notes the time. */
  output(id: string): void
  forget(id: string): void
}

export function createSessionSync(deps: SessionSyncDeps): SessionSync {
  const now = deps.now ?? Date.now
  const alive = deps.alive ?? pidAlive
  const minGap = deps.minGapMs ?? MIN_GAP_MS
  const heardAt = new Map<string, number>()
  const outputAt = new Map<string, number>()
  let last: SyncReport | null = null
  let lastRun = -Infinity
  let running: Promise<SyncReport | null> | null = null

  const run = async (reason: string): Promise<SyncReport | null> => {
    lastRun = now()
    const list = await deps.host.refresh().catch(() => null)
    const plan = planSync({
      nodes: deps.nodes(),
      sessions: deps.host.sessions(),
      alive,
      now: now(),
      lastHeard: (id) => {
        const times = [heardAt.get(id), deps.since(id), deps.latestSignal?.(id)].filter((t): t is number => t !== undefined)
        return times.length ? Math.max(...times) : undefined
      },
      lastOutput: (id) => outputAt.get(id)
    })
    for (const id of plan.reattach) {
      deps.log?.(`Session sync (${reason}): ${id} was shown as ended but still runs, so it's shown again.`)
      deps.reattach(id)
    }
    for (const id of plan.gone) {
      deps.log?.(`Session sync (${reason}): ${id}'s process is gone, so it's marked as ended.`)
      void deps.host.kill(id).catch(() => {})
    }
    for (const id of plan.stale) {
      const status = statusFromTranscript(await deps.transcript(id).catch(() => null))
      deps.log?.(`Session sync (${reason}): ${id} had heard nothing for a long while at its prompt, so its status is now ${status}.`)
      deps.seed(id, status)
    }
    if (plan.orphans.length) deps.log?.(`Session sync (${reason}): ${plan.orphans.length} session(s) in the host have no node: ${plan.orphans.join(', ')}.`)
    last = { at: now(), hostReached: list !== null, rows: plan.rows }
    deps.onReport?.(last)
    return last
  }

  return {
    check(reason, force = false) {
      if (running) return running
      if (!force && now() - lastRun < minGap) return Promise.resolve(last)
      running = run(reason).finally(() => {
        running = null
      })
      return running
    },
    report: () => last,
    heard(id) {
      heardAt.set(id, now())
    },
    output(id) {
      outputAt.set(id, now())
    },
    forget(id) {
      heardAt.delete(id)
      outputAt.delete(id)
    }
  }
}
