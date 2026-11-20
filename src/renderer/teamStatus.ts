import type { NodeMessage } from '../shared/contract'
import type { AgentStop } from '../shared/agentStop'
import type { AgentStatus, CanvasNode } from '../shared/model'
import { agentLook, TONE_ORDER, type Look } from './status/status'

/** How a group's agents are doing, for its header: one light each, and a few words. */
export interface TeamStatus {
  members: Array<{ id: string; title: string; status: AgentStatus; look: Look }>
  /** Such as "1 needs you, 2 working". Empty for a group with no agents. */
  summary: string
  /** The newest message to or from one of them, if any. */
  latest: NodeMessage | null
}

/** The summary's word for a member: its status word, or, for one stopped on an API error, whether it waits or is held. */
function word(look: Look, stopped: boolean): string {
  if (stopped) return look.tone === 'waits' ? 'at a limit' : 'stopped'
  return look.label.toLowerCase()
}

/**
 * `stopped` holds why agents' turns ended on an API error, such as a usage limit. Members are in the status system's
 * order, most pressing first, which is also the order of the lights and the summary.
 */
export function teamStatus(nodes: CanvasNode[], statuses: Record<string, AgentStatus>, messages: NodeMessage[], groupId: string, stopped: Record<string, AgentStop | undefined> = {}, now = Date.now()): TeamStatus {
  const rank = (look: Look): number => TONE_ORDER.indexOf(look.tone)
  const members = nodes
    .filter((n) => n.kind === 'claude' && n.parentId === groupId)
    .map((n) => {
      const status = statuses[n.id] ?? 'unknown'
      return { id: n.id, title: n.title, status, look: agentLook(status, stopped[n.id], now) }
    })
    .sort((a, b) => rank(a.look) - rank(b.look))
  const counts = new Map<string, number>()
  for (const m of members) {
    const key = word(m.look, m.status === 'unknown' && !!stopped[m.id])
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const summary = [...counts].map(([w, n]) => `${n} ${w}`).join(', ')
  const ids = new Set(members.map((m) => m.id))
  let latest: NodeMessage | null = null
  for (let i = messages.length - 1; i >= 0 && !latest; i--) if (ids.has(messages[i].from) || ids.has(messages[i].to)) latest = messages[i]
  return { members, summary, latest }
}
