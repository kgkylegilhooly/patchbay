import type { CanvasNode } from '../../shared/model'

/**
 * A hook knows its node only by PATCHBAY_NODE_ID and PATCHBAY_TOKEN in its environment. A program that ran one
 * session's hooks with another session's environment, as Codex's shared background server can, would report as the
 * wrong node with a valid token. The session id in the hook's own input can't be borrowed that way, so a hook naming a
 * session Patchbay knows belongs to a different node is refused.
 *
 * A session nobody has yet, such as a node's first, can't be checked this way: that is what --no-daemon is for.
 *
 * Returns the node the session belongs to when that isn't the caller, otherwise null.
 */
export function hookFromAnotherNode(callerId: string, payload: Record<string, unknown>, nodes: readonly CanvasNode[]): string | null {
  const sessionId = payload.session_id
  if (typeof sessionId !== 'string' || !sessionId) return null
  const owners = nodes.filter((n) => n.kind === 'claude' && n.sessionId === sessionId)
  if (owners.length === 0 || owners.some((n) => n.id === callerId)) return null
  return owners[0].id
}
