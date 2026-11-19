import type { NodeMessage } from '../shared/contract'
import type { AgentStatus, CanvasNode } from '../shared/model'

/** How a group's agents are doing, for its header: one light each, and a few words. */
export interface TeamStatus {
  members: Array<{ id: string; title: string; status: AgentStatus }>
  /** Such as "1 needs you, 2 working". Empty for a group with no agents. */
  summary: string
  /** The newest message to or from one of them, if any. */
  latest: NodeMessage | null
}

/** Most pressing first, which is also the order the lights are in. */
const ORDER: AgentStatus[] = ['needs-you', 'working', 'starting', 'queued', 'idle', 'exited', 'unknown']
const WORDS: Record<AgentStatus, string> = {
  'needs-you': 'needs you',
  working: 'working',
  starting: 'starting',
  queued: 'waiting to start',
  idle: 'idle',
  exited: 'ended',
  unknown: 'unknown'
}

/** `stopped` holds the agents whose turn ended on an API error, such as a usage limit: counted as stopped, not unknown. */
export function teamStatus(nodes: CanvasNode[], statuses: Record<string, AgentStatus>, messages: NodeMessage[], groupId: string, stopped: Record<string, unknown> = {}): TeamStatus {
  const members = nodes
    .filter((n) => n.kind === 'claude' && n.parentId === groupId)
    .map((n) => ({ id: n.id, title: n.title, status: statuses[n.id] ?? 'unknown' }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const counts = new Map<AgentStatus | 'stopped', number>()
  for (const m of members) {
    const key = m.status === 'unknown' && m.id in stopped ? 'stopped' : m.status
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const summary = [...ORDER.slice(0, -1), 'stopped' as const, 'unknown' as const]
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s === 'stopped' ? 'stopped' : WORDS[s]}`)
    .join(', ')
  const ids = new Set(members.map((m) => m.id))
  let latest: NodeMessage | null = null
  for (let i = messages.length - 1; i >= 0 && !latest; i--) if (ids.has(messages[i].from) || ids.has(messages[i].to)) latest = messages[i]
  return { members, summary, latest }
}
