import { open, stat } from 'node:fs/promises'
import { codexStopFailure, emptyCodexTurn, foldCodexLine, type CodexTurnState } from '../../core/status/codexRollout'
import type { AgentStatus } from '../../shared/model'
import { backoffInterval } from '../backoff'
import type { PlanUsage } from '../../shared/usage'

/**
 * Codex's limit, failure and interrupt states, mapped onto what Claude's hooks give: a failed turn becomes the
 * StopFailure Claude would have sent (status `unknown` plus a stop record, so usage limits hold messages until the
 * reset), and a turn aborted by Esc becomes Interrupt (status `idle`), for sessions whose launch didn't register the
 * Interrupt hook. Read from each Codex node's rollout file as it grows. See src/core/status/codexRollout.ts and
 * docs/plans/followups-integration.md, which says what is UNVERIFIED.
 */

export interface CodexNodeInfo {
  id: string
  transcriptPath: string
  /** The window's own Codex session, once SessionStart has said it. */
  sessionId?: string | null
}

export interface CodexStops {
  /**
   * For a Codex node's Stop hook: reads its rollout first, and when the turn failed, gives the StopFailure it stands
   * for instead, with Codex's own limits for the reset time. Anything else comes back as it was.
   */
  translate(id: string, payload: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; limits?: PlanUsage | null; ignore?: true }>
  /** Looks once. Runs by itself on a timer as well. */
  tick(): Promise<void>
  close(): void
}

/** A rollout seen for the first time is read from this far before its end: enough for the latest turn's events. */
const FIRST_LOOK_BYTES = 256 * 1024
const MAX_READ = 4 * 1024 * 1024
/**
 * A turn whose fatal error is followed by nothing for this long, with neither its end nor a Stop hook, is taken as
 * ended on that error. Codex's `error` event ends the turn; `stream_error` (a retry) is a different event.
 */
const QUIET_AFTER_ERROR_MS = 30_000

interface Followed {
  path: string
  offset: number
  turn: CodexTurnState
  /** Failures and aborts already acted on (or there before Patchbay looked), so each is applied once. */
  done: Set<string>
  /** When the file last grew. */
  grewAt: number
}

const failureKey = (t: CodexTurnState): string | null => (t.failure ? `f:${t.failure.at}:${t.failure.message}` : null)
const abortKey = (t: CodexTurnState): string | null => (t.aborted ? `a:${t.aborted.at}:${t.aborted.reason}` : null)

export function createCodexStops(d: {
  nodes(): CodexNodeInfo[]
  status(id: string): AgentStatus
  /** Applies a hook as if it had come from Codex: the status first, then the stop record. */
  apply(id: string, payload: Record<string, unknown>, limits?: PlanUsage | null): Promise<void>
  now?: () => number
  everyMs?: number
  log?(line: string): void
}): CodexStops {
  const now = d.now ?? Date.now
  const followed = new Map<string, Followed>()
  const reading = new Map<string, Promise<void>>()
  let closed = false

  const read = (node: CodexNodeInfo): Promise<void> => {
    const run = (reading.get(node.id) ?? Promise.resolve()).then(async () => {
      let f = followed.get(node.id)
      let size: number
      try {
        size = (await stat(node.transcriptPath)).size
      } catch {
        return
      }
      let first = false
      if (!f || f.path !== node.transcriptPath || size < f.offset) {
        first = !f || f.path !== node.transcriptPath
        f = { path: node.transcriptPath, offset: first ? Math.max(0, size - FIRST_LOOK_BYTES) : 0, turn: emptyCodexTurn(), done: new Set(), grewAt: now() }
        followed.set(node.id, f)
      }
      if (size === f.offset) return
      const handle = await open(node.transcriptPath, 'r')
      let bytes: Buffer
      try {
        const buffer = Buffer.alloc(Math.min(size - f.offset, MAX_READ))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, f.offset)
        bytes = buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
      let start = 0
      // Started partway into the file: the first line is a piece of one.
      if (first && f.offset > 0) start = bytes.indexOf(0x0a) + 1
      const end = bytes.lastIndexOf(0x0a) + 1
      if (end <= start) {
        if (bytes.length === MAX_READ) f.offset += bytes.length // One huge line: passed over.
        return
      }
      for (const line of bytes.subarray(start, end).toString('utf8').split('\n')) if (line) f.turn = foldCodexLine(f.turn, line)
      f.offset += end
      f.grewAt = now()
      const status = d.status(node.id)
      if (first && status !== 'working' && status !== 'needs-you') {
        // Seen first between turns: what happened before Patchbay looked was already shown, or was saved as a stop.
        for (const k of [failureKey(f.turn), abortKey(f.turn)]) if (k) f.done.add(k)
      }
    })
    const settled = run.catch((e: unknown) => d.log?.(`Reading Codex rollout of ${node.id} failed: ${String(e)}`))
    reading.set(node.id, settled)
    return settled
  }

  /** Acts on what the rollout says now: a failed turn that has ended, or an interrupt the hooks didn't report. */
  const act = async (node: CodexNodeInfo): Promise<void> => {
    const f = followed.get(node.id)
    if (!f) return
    const status = d.status(node.id)
    if (status === 'exited' || status === 'starting' || status === 'queued') return
    const fk = failureKey(f.turn)
    if (fk && !f.done.has(fk)) {
      // The turn ended on it (an error it went on from was already dropped from the state), or nothing followed it.
      const ended = f.turn.ended || (status === 'working' && now() - f.grewAt >= QUIET_AFTER_ERROR_MS)
      if (ended) {
        f.done.add(fk)
        await d.apply(node.id, codexStopFailure(f.turn)!, f.turn.plan)
        return
      }
    }
    const ak = abortKey(f.turn)
    if (ak && !f.done.has(ak) && f.turn.aborted?.reason === 'interrupted') {
      f.done.add(ak)
      // Esc leaves the node `unknown`; Codex is at its prompt again. A node that moved on since is left alone.
      if (status === 'unknown' || status === 'working') await d.apply(node.id, { hook_event_name: 'Interrupt' })
    }
  }

  let ticking = false
  const tick = async (): Promise<void> => {
    if (ticking || closed) return
    ticking = true
    try {
      const nodes = d.nodes()
      const ids = new Set(nodes.map((n) => n.id))
      for (const id of [...followed.keys()]) if (!ids.has(id)) followed.delete(id)
      for (const node of nodes) {
        if (d.status(node.id) === 'exited') continue
        await read(node)
        await act(node)
      }
    } finally {
      ticking = false
    }
  }
  // With no Codex window there's nothing to read, so the look slows down until there is one.
  const timer =
    d.everyMs === 0
      ? null
      : backoffInterval(async () => {
          await tick()
          return d.nodes().length > 0
        }, d.everyMs ?? 2000, (d.everyMs ?? 2000) * 4)

  return {
    async translate(id, payload) {
      const name = payload.hook_event_name
      if (name !== 'Stop' && name !== 'Interrupt') return { payload }
      const node = d.nodes().find((n) => n.id === id)
      if (!node) return { payload }
      // A subagent is a thread in the same process, so its hooks carry this window's node. A Stop or Interrupt of
      // another session than the window's own is a child's, and says nothing about the window.
      const session = typeof payload.session_id === 'string' ? payload.session_id : null
      if (session && node.sessionId && session !== node.sessionId) return { payload, ignore: true }
      if (name !== 'Stop') return { payload }
      await read(node)
      const f = followed.get(id)
      const fk = f && failureKey(f.turn)
      // The turn this Stop ends failed: it ends as Claude's StopFailure would.
      if (!f || !fk || f.done.has(fk)) return { payload }
      f.done.add(fk)
      return { payload: codexStopFailure(f.turn)!, limits: f.turn.plan }
    },
    tick,
    close() {
      closed = true
      timer?.close()
    }
  }
}
