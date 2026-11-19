import type { AgentStatus, CanvasDoc } from '../shared/model'
import type { PendingTool, WaitSince } from '../shared/needsYouBridge'
import { bucketOf } from './sidebarView'

/** Pure: which agents "Next needing you" walks, and how a peek words a wait. */

export interface QueueEntry {
  id: string
  bucket: 'needs-you' | 'unread'
  /** When it got that way, or null if Patchbay hasn't seen it change. */
  since: number | null
}

/**
 * The agent windows to go to, in turn: Need attention, the longest waiting first, then, if asked for, Unread (finished
 * or stopped, not looked at) likewise. Every project counts, closed ones too, as the Status tab shows. The buckets are
 * the Status tab's own, so a session is never jumped to for a status that view wouldn't give it. Unknown is never
 * jumped to: nothing says it needs anyone.
 */
/** `stopped`: agents whose turn ended on an API error, such as a usage limit, which the Status tab lists under Need attention too. */
export function needsYouQueue(doc: CanvasDoc, statuses: Record<string, AgentStatus>, attention: string[], waits: Record<string, WaitSince>, includeUnread: boolean, stopped: Record<string, unknown> = {}): QueueEntry[] {
  const unread = new Set(attention)
  const entries: (QueueEntry & { order: number })[] = []
  doc.nodes.forEach((node, order) => {
    if (node.kind !== 'claude') return
    const bucket = bucketOf(node.kind, statuses[node.id] ?? null, unread.has(node.id), node.id in stopped)
    if (bucket === 'needs-you' || (includeUnread && bucket === 'unread')) entries.push({ id: node.id, bucket, since: waits[node.id]?.at ?? null, order })
  })
  const rank = (e: QueueEntry): number => (e.bucket === 'needs-you' ? 0 : 1)
  // Without a time it has waited at least as long as Patchbay has known, so it goes first.
  return entries
    .sort((a, b) => rank(a) - rank(b) || (a.since ?? -Infinity) - (b.since ?? -Infinity) || a.order - b.order)
    .map(({ order: _order, ...e }) => e)
}

/** The one after the last one gone to, round to the start. The start when that one has left the queue. */
export function nextInQueue(queue: QueueEntry[], lastId: string | null): QueueEntry | null {
  if (queue.length === 0) return null
  const at = lastId === null ? -1 : queue.findIndex((e) => e.id === lastId)
  return queue[(at + 1) % queue.length]
}

/** A length of time, short: "under a minute", "4m", "1h 5m", "2d 3h". */
export function duration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/**
 * How long a session has been the way it is, in words for its status, or null when there's nothing worth saying.
 * A time Patchbay only found on starting up is a floor, so it says so.
 */
export function waitText(status: AgentStatus | null, since: WaitSince | null, now: number): { text: string; title?: string } | null {
  if (!since) return null
  const length = duration(now - since.at)
  const plus = since.exact || length === 'under a minute' ? '' : '+'
  const title = since.exact ? undefined : 'Counted from when Patchbay started. It may have been longer.'
  switch (status) {
    case 'needs-you':
      return { text: `Waiting ${length}${plus}`, title }
    case 'idle':
      return { text: since.exact && length === 'under a minute' ? 'Finished just now' : `Finished ${length}${plus} ago`, title }
    case 'exited':
      return { text: `Stopped ${length}${plus} ago`, title }
    case 'working':
      return { text: `Working for ${length}${plus}`, title }
    default:
      return null
  }
}

/** Calls that start a subagent. Still running while the subagent asks, so naming one would point at the wrong thing. */
const SUBAGENT_CALLS = new Set(['Task', 'Agent'])

export type Ask = { kind: 'call'; tool: string; summary: string } | { kind: 'subagent' } | null

/**
 * What a session at Need attention is waiting on: a held approval, which is exact, or else the transcript's newest
 * call with no result. Null when it isn't waiting on you, or Patchbay can't tell.
 */
export function whatItAsks(status: AgentStatus | null, approval: PendingTool | undefined, pending: PendingTool | null | undefined): Ask {
  if (status !== 'needs-you') return null
  if (approval) return { kind: 'call', ...approval }
  if (!pending) return null
  return SUBAGENT_CALLS.has(pending.tool) ? { kind: 'subagent' } : { kind: 'call', ...pending }
}

/** What a queued reply is waiting for, in the session's own terms. */
export function queuedText(status: AgentStatus | null): string {
  switch (status) {
    case 'needs-you':
      return 'Queued. It goes once the prompt in its window is answered.'
    case 'unknown':
      return "Queued. Patchbay can't tell whether it's ready, so this waits until it next finishes. Open its window to type now."
    default:
      return 'Queued. It goes when the agent is next idle.'
  }
}
