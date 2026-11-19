import type { CanvasNode } from '../../shared/model'

/**
 * A hook knows its node only by PATCHBAY_NODE_ID and PATCHBAY_TOKEN in its environment. A program that ran one
 * session's hooks with another session's environment, as Codex's shared background server can, would report as the
 * wrong node with a valid token. The session id in the hook's own input can't be borrowed that way, so a hook naming a
 * session that a different, running node holds is refused.
 *
 * Only a running owner counts. The person may /resume, in one node, a conversation another node held before it
 * exited: that node then works in the session, and its SessionStart records it as its own, as before.
 *
 * A session nobody has yet, such as a node's first, can't be checked this way: that is what --no-daemon is for.
 *
 * Returns the node the session belongs to when that isn't the caller, otherwise null.
 */
export function hookFromAnotherNode(
  callerId: string,
  payload: Record<string, unknown>,
  nodes: readonly CanvasNode[],
  running: (id: string) => boolean
): string | null {
  const sessionId = payload.session_id
  if (typeof sessionId !== 'string' || !sessionId) return null
  const owners = nodes.filter((n) => n.kind === 'claude' && n.sessionId === sessionId)
  if (owners.some((n) => n.id === callerId)) return null
  return owners.find((n) => running(n.id))?.id ?? null
}

/** Says the first refusal for each pair of nodes, then only every hundredth, so a busy session can't flood the log. */
export function refusalLog(write: (line: string) => void): (callerId: string, ownerId: string, event: unknown) => void {
  const counts = new Map<string, number>()
  return (callerId, ownerId, event) => {
    const key = `${callerId}\0${ownerId}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count === 1) write(`Refused a ${String(event)} hook sent as ${callerId} for a session of running node ${ownerId}.`)
    else if (count % 100 === 0) write(`Refused ${count} hooks sent as ${callerId} for a session of ${ownerId} so far.`)
  }
}
