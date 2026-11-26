import type { NodeError } from '../shared/contract'
import { inActiveProject, type AgentStatus, type CanvasDoc, type CanvasNode } from '../shared/model'

/**
 * A group's windows, all at once: after a crash or a failed batch, every exited one needed its own Restart, and a team
 * going the wrong way had to be stopped window by window.
 */

/** The nodes inside a group, at any depth, the group itself left out. */
function insideGroup(nodes: CanvasNode[], groupId: string): CanvasNode[] {
  const inside = new Set([groupId])
  for (let grew = true; grew; ) {
    grew = false
    for (const n of nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) grew = !!inside.add(n.id)
  }
  return nodes.filter((n) => n.id !== groupId && inside.has(n.id))
}

/** The agents inside a group that are working now. One waiting on the person isn't: Esc there would answer for them. */
export function workingIn(nodes: CanvasNode[], groupId: string, statuses: Partial<Record<string, AgentStatus>>): CanvasNode[] {
  return insideGroup(nodes, groupId).filter((n) => n.kind === 'claude' && statuses[n.id] === 'working')
}

/** The agents in the project on screen that are working now (F67), for Interrupt N working agents on the canvas. */
export function workingInProject(doc: Pick<CanvasDoc, 'nodes' | 'activeProjectId'> | null | undefined, statuses: Partial<Record<string, AgentStatus>>): CanvasNode[] {
  if (!doc) return []
  return doc.nodes.filter((n) => n.kind === 'claude' && inActiveProject(doc, n) && statuses[n.id] === 'working')
}

/**
 * The agent and terminal windows inside a group, at any depth, that have exited or couldn't start, in canvas order.
 * Run windows are left out: restarting one runs its command again. So is a start that's only waiting for memory,
 * which goes by itself.
 */
export function stoppedIn(nodes: CanvasNode[], groupId: string, statuses: Partial<Record<string, AgentStatus>>, errors: Partial<Record<string, NodeError>>): string[] {
  return insideGroup(nodes, groupId)
    .filter((n) => n.kind === 'claude' || n.kind === 'terminal')
    .filter((n) => {
      const error = errors[n.id]
      if (error?.fix === 'memory') return false
      return statuses[n.id] === 'exited' || !!error
    })
    .map((n) => n.id)
}
