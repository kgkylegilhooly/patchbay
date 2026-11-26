import { create } from 'zustand'
import type { CanvasDoc, ClaudeNode } from '../shared/model'

/**
 * One message to several agents at once: "stop and commit", "rebase on main", typed once for a whole team rather than
 * into each window. It goes through each agent's send queue, so a busy one gets it when it's idle.
 */

/** The agents among the selected nodes and inside selected groups, at any depth, once each, in canvas order. */
export function selectedAgents(doc: CanvasDoc, ids: string[]): ClaudeNode[] {
  const inside = new Set(ids)
  for (let grew = true; grew; ) {
    grew = false
    for (const n of doc.nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) grew = !!inside.add(n.id)
  }
  return doc.nodes.filter((n): n is ClaudeNode => n.kind === 'claude' && inside.has(n.id))
}

/** The agents the box is open for, or null when it's closed. Kept apart from the canvas store. */
export const useSendToAgents = create<{ ids: string[] | null }>(() => ({ ids: null }))
export const openSendToAgents = (ids: string[]): void => useSendToAgents.setState({ ids: ids.length ? ids : null })
export const closeSendToAgents = (): void => useSendToAgents.setState({ ids: null })
