import type { NodeError } from '../shared/contract'
import type { AgentStatus, CanvasNode } from '../shared/model'

/**
 * After a crash or a failed batch, every exited window in a group needed its own Restart. A group's menu restarts them
 * all at once.
 */

/**
 * The agent and terminal windows inside a group, at any depth, that have exited or couldn't start, in canvas order.
 * Run windows are left out: restarting one runs its command again. So is a start that's only waiting for memory,
 * which goes by itself.
 */
export function stoppedIn(nodes: CanvasNode[], groupId: string, statuses: Partial<Record<string, AgentStatus>>, errors: Partial<Record<string, NodeError>>): string[] {
  const inside = new Set([groupId])
  for (let grew = true; grew; ) {
    grew = false
    for (const n of nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) grew = !!inside.add(n.id)
  }
  return nodes
    .filter((n) => (n.kind === 'claude' || n.kind === 'terminal') && n.id !== groupId && inside.has(n.id))
    .filter((n) => {
      const error = errors[n.id]
      if (error?.fix === 'memory') return false
      return statuses[n.id] === 'exited' || !!error
    })
    .map((n) => n.id)
}
