import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { agentIdOf, emptyProgress, foldLines, parseMeta, type Progress, type SubagentMeta } from '../../core/subagents/parse'
import type { CanvasStore } from '../../shared/contract'
import { agentOf, type AgentStatus } from '../../shared/model'
import type { SubagentCard, SubagentSnapshot } from '../../shared/subagents'
import { backoffInterval } from '../backoff'

/**
 * Follows the subagents of Claude windows, from the files Claude Code writes beside each transcript. Only windows
 * mid-turn, or with a subagent still running, are looked at, once a second: one stat of the folder, a listing only when
 * it changed, and each running agent's transcript read from where the last read stopped, up to its last complete line.
 * Nothing here is saved or reaches the canvas document. See docs/plans/subagent-cards.md.
 */

/** The folder a session's subagents are written to: beside its transcript, named after the session. */
export function subagentDir(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/i, ''), 'subagents')
}

export interface WatchedParent {
  nodeId: string
  transcriptPath: string
  /** Working or waiting on the person: a turn is under way. */
  busy: boolean
  /** The session has ended, so nothing it started is still running. */
  exited: boolean
}

export interface SubagentWatcher {
  /** Looks once. Runs by itself on a timer as well. */
  tick(): Promise<void>
  snapshot(): SubagentSnapshot
  /** The window began a new turn: earlier subagents stop counting. */
  turnStarted(nodeId: string, at?: number): void
  close(): void
}

interface Agent {
  id: string
  meta: SubagentMeta | null
  metaMtime: number
  offset: number
  progress: Progress
  /** Finished before this was first watched, in an earlier turn: never shown, never read. */
  old: boolean
  status: SubagentCard['status']
  failure?: string
  startedAt: number
  endedAt?: number
  /** The parent's turn it counts in: the one it started in, or the latest one it was still running at. */
  turn: number
  /** Partway through a line longer than a read, which is passed over to its end. */
  skipping?: boolean
  /** Settled because it went quiet with its window idle. It runs again if its transcript grows. */
  stale?: boolean
  /** The tick it was last read in, so the least recently read go first when there are too many. */
  readTick: number
}

interface Parent {
  dir: string
  dirMtime: number
  agents: Map<string, Agent>
  turnStart: number
  turn: number
}

/** A running agent's transcript read this many at a time per window, so a runaway fan-out can't stall a tick. */
const READS_PER_TICK = 24
/** At most this many cards per window are sent on. The count still covers them all. */
const SENT_CAP = 50
/** An unfinished agent whose transcript hasn't changed in this long, from before the turn, was left by a crash. */
const ORPHAN_MS = 10 * 60_000
/**
 * A running agent whose transcript has been quiet this long while its window is idle has gone without saying so (a
 * crash, a killed process). Longer than the longest tool call Claude Code allows, ten minutes, so a long Bash isn't it.
 */
const STALE_MS = 11 * 60_000
/** The most read from one transcript in one go. The rest is read on later ticks. */
const MAX_READ = 4 * 1024 * 1024

async function readFrom(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(end - start, MAX_READ))
    let at = 0
    while (at < buffer.length) {
      const { bytesRead } = await handle.read(buffer, at, buffer.length - at, start + at)
      if (bytesRead === 0) break
      at += bytesRead
    }
    return buffer.subarray(0, at)
  } finally {
    await handle.close()
  }
}

export function createSubagentWatcher(opts: {
  parents(): WatchedParent[]
  push(snapshot: SubagentSnapshot): void
  now?: () => number
  everyMs?: number
  log?(message: string): void
  /** Cards from elsewhere, such as Codex windows' hooks (codexCards.ts): brought up to date each tick, then merged in. */
  also?: { refresh(): Promise<void>; snapshot(): SubagentSnapshot }
}): SubagentWatcher {
  const now = opts.now ?? Date.now
  const parents = new Map<string, Parent>()
  let last = '{}'
  let ticking = false
  let closed = false

  let tickCount = 0

  const settle = (a: Agent, at: number): void => {
    a.stale = false
    const stopped = a.meta?.stoppedByUser
    a.status = a.progress.error || stopped ? 'failed' : 'done'
    a.failure = stopped ? 'Stopped' : a.progress.error
    a.endedAt = a.progress.lastAt ?? at
  }

  /** Reads what was added to one agent's transcript since last time. A line still being written waits. */
  const follow = async (p: Parent, a: Agent, size: number): Promise<void> => {
    if (size < a.offset) {
      a.offset = 0 // Replaced, so read afresh.
      a.progress = emptyProgress()
      a.skipping = false
    }
    if (size === a.offset) return
    const bytes = await readFrom(join(p.dir, `agent-${a.id}.jsonl`), a.offset, size)
    let start = 0
    if (a.skipping) {
      const nl = bytes.indexOf(0x0a)
      if (nl === -1) {
        a.offset += bytes.length
        return
      }
      start = nl + 1
      a.skipping = false
    }
    const end = bytes.lastIndexOf(0x0a) + 1
    if (end <= start) {
      a.offset += start
      // A whole read with no line end is one line too long to wait for, such as a tool result holding an image. It
      // tells a card nothing, so it's passed over rather than read again every second.
      if (start === 0 && bytes.length === MAX_READ) {
        a.skipping = true
        a.offset += bytes.length
      }
      return
    }
    a.progress = foldLines(a.progress, bytes.subarray(start, end).toString('utf8'))
    a.offset += end
    if (a.progress.startedAt !== undefined) a.startedAt = a.progress.startedAt
  }

  const look = async (nodeId: string, w: WatchedParent): Promise<void> => {
    let p = parents.get(nodeId)
    const dir = subagentDir(w.transcriptPath)
    if (!p || p.dir !== dir) {
      p = { dir, dirMtime: -1, agents: new Map(), turnStart: now(), turn: 0 }
      parents.set(nodeId, p)
    }
    const running = [...p.agents.values()].filter((a) => !a.old && a.status === 'running')
    if (w.exited) {
      for (const a of running) {
        a.status = 'failed'
        a.failure = 'The session ended'
        a.endedAt = now()
      }
      return
    }
    if (!w.busy && running.length === 0) return

    let dirStat
    try {
      dirStat = await stat(p.dir)
    } catch {
      return // No subagents yet.
    }
    if (dirStat.mtimeMs !== p.dirMtime) {
      p.dirMtime = dirStat.mtimeMs
      for (const name of await readdir(p.dir).catch(() => [] as string[])) {
        const id = agentIdOf(name)
        if (id && !p.agents.has(id)) p.agents.set(id, { id, meta: null, metaMtime: -1, offset: 0, progress: emptyProgress(), old: false, status: 'running', startedAt: now(), turn: p.turn, readTick: 0 })
      }
    }

    let reads = 0
    const tick = ++tickCount
    // The least recently read first, so with more running than can be read in one tick, every one gets its turn.
    const live = [...p.agents.values()].filter((a) => !a.old && (a.status === 'running' || a.stale)).sort((x, y) => x.readTick - y.readTick)
    for (const a of live) {
      const jsonl = join(p.dir, `agent-${a.id}.jsonl`)
      try {
        const metaFile = join(p.dir, `agent-${a.id}.meta.json`)
        const metaStat = await stat(metaFile).catch(() => null)
        if (metaStat && metaStat.mtimeMs !== a.metaMtime) {
          const meta = parseMeta(await readFile(metaFile, 'utf8'))
          // Read mid-write, it's looked at again next time.
          if (meta) {
            a.meta = meta
            a.metaMtime = metaStat.mtimeMs
          }
        }
        let file
        try {
          file = await stat(jsonl)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          settle(a, now())
          a.status = 'failed'
          a.failure = 'Its transcript is gone'
          continue
        }
        if (a.stale) {
          if (file.size === a.offset) continue
          a.stale = false
          a.status = 'running'
          a.endedAt = undefined
          a.failure = undefined
        }
        const fresh = a.offset === 0 && a.progress.startedAt === undefined
        if (fresh) {
          a.startedAt = file.birthtimeMs || file.mtimeMs
          // From an earlier turn: finished, or abandoned long ago. Never read, however big.
          const before = file.mtimeMs < p.turnStart
          if (before && (a.meta?.finished || a.meta?.stoppedByUser || now() - file.mtimeMs > ORPHAN_MS)) {
            a.old = true
            continue
          }
        }
        const done = a.meta?.finished || a.meta?.stoppedByUser
        if (file.size !== a.offset) {
          // Only reads count against the limit. A finished agent left unread waits a tick, so its card ends right.
          if (reads >= READS_PER_TICK) continue
          reads++
          a.readTick = tick
          await follow(p, a, file.size)
        }
        if (done) settle(a, file.mtimeMs)
        else if (!w.busy && now() - file.mtimeMs > STALE_MS) {
          settle(a, file.mtimeMs)
          a.status = 'failed'
          a.failure = 'No longer running'
          a.stale = true
        }
      } catch (e) {
        opts.log?.(`Subagent ${a.id} couldn't be read: ${(e as Error).message}`)
      }
    }
  }

  const build = (): SubagentSnapshot => {
    const out: SubagentSnapshot = {}
    for (const [nodeId, p] of parents) {
      const cards: SubagentCard[] = []
      for (const a of p.agents.values()) {
        if (a.old || a.turn !== p.turn) continue
        cards.push({
          id: a.id,
          parentId: nodeId,
          agentType: a.meta?.agentType ?? 'agent',
          description: a.meta?.description || a.progress.prompt || 'Subagent',
          status: a.status,
          ...(a.failure ? { failure: a.failure } : {}),
          startedAt: a.startedAt,
          ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
          tools: a.progress.tools,
          ...(a.progress.tokens !== undefined ? { tokens: a.progress.tokens } : {}),
          depth: a.meta?.depth ?? 1
        })
      }
      if (cards.length === 0) continue
      cards.sort((x, y) => Number(y.status === 'running') - Number(x.status === 'running') || y.startedAt - x.startedAt)
      out[nodeId] = { ran: cards.length, cards: cards.slice(0, SENT_CAP).sort((x, y) => x.startedAt - y.startedAt) }
    }
    return out
  }

  /** Whether the last look found anything moving: a busy window, or cards that changed. See backoff.ts. */
  let active = true
  const tick = async (): Promise<void> => {
    if (ticking || closed) return
    ticking = true
    try {
      const watched = opts.parents()
      active = watched.some((w) => w.busy)
      const ids = new Set(watched.map((w) => w.nodeId))
      for (const id of [...parents.keys()]) if (!ids.has(id)) parents.delete(id)
      for (const w of watched) await look(w.nodeId, w)
      // A subagent can still be running after its window's turn has ended.
      for (const p of parents.values()) for (const a of p.agents.values()) if (a.status === 'running') active = true
      await opts.also?.refresh().catch((e: unknown) => opts.log?.(`Codex subagent cards: ${String(e)}`))
      const snap = { ...build(), ...(opts.also?.snapshot() ?? {}) }
      const text = JSON.stringify(snap)
      if (text !== last && !closed) {
        last = text
        active = true
        opts.push(snap)
      }
      // A look asked for from outside, as on a status change, that finds things moving: the timer may still be at its
      // slowest, and would keep that pace until its own next look, up to 8 s, so a first card would come late.
      if (active) timer?.wake()
    } finally {
      ticking = false
    }
  }

  // Every second while a window is busy or cards change; slower while nothing does. A status change ticks at once.
  const timer =
    opts.everyMs === 0
      ? null
      : backoffInterval(async () => {
          await tick()
          return active
        }, opts.everyMs ?? 1000)

  return {
    tick,
    snapshot: () => JSON.parse(last) as SubagentSnapshot,
    turnStarted(nodeId, at = now()) {
      const p = parents.get(nodeId)
      if (!p) return
      p.turnStart = at
      p.turn++
      for (const a of p.agents.values()) if (a.status === 'running') a.turn = p.turn
    },
    close() {
      closed = true
      timer?.close()
    }
  }
}

/** Which windows to follow: Claude ones with a transcript. Codex windows have no subagent folder to read. */
export function watchedParents(store: CanvasStore, status: (id: string) => AgentStatus): WatchedParent[] {
  return store.get().nodes.flatMap((n) => {
    if (n.kind !== 'claude' || agentOf(n) !== 'claude' || !n.transcriptPath) return []
    const s = status(n.id)
    return [{ nodeId: n.id, transcriptPath: n.transcriptPath, busy: s === 'working' || s === 'needs-you', exited: s === 'exited' }]
  })
}
