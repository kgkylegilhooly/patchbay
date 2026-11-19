import { stopExplained, type AgentStop } from '../../shared/agentStop'
import { agentOf, type AgentStatus, type CanvasNode } from '../../shared/model'
import { RpcRefusal } from './server'

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

/** How `list`, `wait` and `send` describe a node stopped on StopFailure. */
export function stoppedEntry(stop: AgentStop, now = Date.now()): { kind: AgentStop['kind']; until: string | null; text: string } {
  return { kind: stop.kind, until: stop.until === null ? null : new Date(stop.until).toISOString(), text: stopExplained(stop, now) }
}

/**
 * `patchbay restart --node ID`: brings back an agent the caller opened that has exited, resuming its conversation the
 * way the person's Restart does. One still running, held by --after, opened by someone else, or turned off in Settings
 * > Agents is refused, and nothing is stopped.
 */
export async function restartVerb(
  caller: string,
  node: CanvasNode,
  deps: {
    status: AgentStatus
    running: boolean
    /** Why this agent may not start now (Settings > Agents), or null. */
    agentOff: (node: CanvasNode & { kind: 'claude' }) => string | null
    restart: (id: string) => Promise<void>
    /** A start error after trying, such as a failed resume. */
    error: (id: string) => string | undefined
  }
): Promise<unknown> {
  const { id } = node
  if (node.openedBy !== caller) refuse(`Can't restart node "${id}": you didn't open it. Ask the person to press Restart on it.`)
  if (node.kind !== 'claude') refuse(`Node "${id}" is a ${node.kind}. restart only brings back agent nodes.`)
  if (deps.status === 'queued') refuse(`Node "${id}" hasn't started: it's held until the agents it waits for (--after) finish a turn.`)
  if (deps.running && deps.status !== 'exited')
    refuse(`Node "${id}" is still running (${deps.status}), so there's nothing to restart. Send it a message instead, or wait for it.`)
  const off = deps.agentOff(node)
  if (off) refuse(`Can't restart node "${id}": ${off}`)
  const resumed = !!node.sessionId
  await deps.restart(id)
  const problem = deps.error(id)
  if (problem) refuse(`Node "${id}" didn't start: ${problem}`)
  // A resume can still fail in its first seconds, which only shows later, so this says what to check.
  return {
    id,
    restarted: true,
    agent: agentOf(node),
    resuming: resumed,
    ...(resumed ? { check: `It's reopening its conversation. If patchbay list shows it exited in a few seconds, the resume failed: patchbay restart starts a new one if its transcript is gone.` } : {})
  }
}
