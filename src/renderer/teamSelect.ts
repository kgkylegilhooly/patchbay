import type { NodeMessage } from '../shared/contract'
import type { AgentStatus, CanvasNode } from '../shared/model'

/**
 * What a group's team line reads from the store, narrowed to its own members. Every status and every message on the
 * canvas used to render every group; with these, one renders only when something of its own team changed. The status
 * map is compared item by item (useShallow), the message by identity.
 */

/** The statuses of the group's agents, by id. A member without one is left out, as in the full map. */
export function memberStatuses(nodes: CanvasNode[] | undefined, statuses: Record<string, AgentStatus>, groupId: string): Record<string, AgentStatus> {
  const out: Record<string, AgentStatus> = {}
  for (const n of nodes ?? []) if (n.kind === 'claude' && n.parentId === groupId && statuses[n.id]) out[n.id] = statuses[n.id]
  return out
}

/** The latest message to or from one of the group's agents, or null. */
export function latestTeamMessage(nodes: CanvasNode[] | undefined, messages: NodeMessage[], groupId: string): NodeMessage | null {
  const ids = new Set<string>()
  for (const n of nodes ?? []) if (n.kind === 'claude' && n.parentId === groupId) ids.add(n.id)
  if (!ids.size) return null
  for (let i = messages.length - 1; i >= 0; i--) if (ids.has(messages[i].from) || ids.has(messages[i].to)) return messages[i]
  return null
}
