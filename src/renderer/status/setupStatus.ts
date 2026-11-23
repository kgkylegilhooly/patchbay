import type { AgentStatus, CanvasNode } from '../../shared/model'
import type { NodeError, RunResult } from '../../shared/contract'
import { startFailureOf } from './startFailure'
import type { Look } from './status'

/**
 * A recipe agent held for its setup commands is `queued` as far as its process goes, but "Queued" reads as "about to
 * start". These say what it really waits for: its setup, or nothing, because a setup step failed and it won't start
 * until the person reruns that step or starts it anyway. Pure, so it's tested without a page.
 */
export type SetupHold = 'waiting' | 'failed'

/** The hold on a node, if it's a recipe agent held for its setup. */
export function setupHoldOf(node: CanvasNode | undefined): SetupHold | undefined {
  if (node?.kind !== 'claude' || !node.setupWait) return undefined
  return node.setupWait.failed ? 'failed' : 'waiting'
}

/** A failed setup is held (a red ring: the person has to act); a running one is pending, as Queued was. */
export const SETUP_LOOKS: Record<SetupHold, Look> = {
  failed: { tone: 'held', label: 'Setup failed', detail: "A setup step failed, so this agent hasn't started" },
  waiting: { tone: 'pending', label: 'Waiting for setup' }
}

/** The hold speaks for the agent only while it hasn't started: once it runs, its own status does. */
export function setupLookFor(status: AgentStatus | null | undefined, hold: SetupHold | undefined): Look | null {
  if (!hold) return null
  return status === 'queued' || status === 'unknown' || !status ? SETUP_LOOKS[hold] : null
}

/**
 * Whether a session is stopped on something only the person can clear, apart from an agent's stop: a recipe agent
 * whose setup failed, until it's fixed, or a run command that exited with an error, until it's been looked at (a
 * failing `npm test` is part of the edit-test loop, so once seen it's just a run that exited, not a call for help).
 * The Status tab lists these under Need attention. `unread`: whether the session is on the attention list.
 */
export function sessionBlocked(node: CanvasNode, status: AgentStatus | null | undefined, run: RunResult | undefined, unread: boolean, error?: NodeError): boolean {
  // An agent that couldn't start, until it's started again.
  if (startFailureOf(node, status, error)) return true
  if (node.kind === 'run') return unread && !!run && !run.running && !run.stoppedByYou && run.exitCode !== null && run.exitCode !== 0
  return setupLookFor(status, setupHoldOf(node))?.tone === 'held'
}

let heldFrom: readonly CanvasNode[] | null = null
let held = new Map<string, SetupHold>()

/**
 * The setup holds by node id, worked out once per change of the node list and shared by every badge that asks, so a
 * status badge's store selector is a map lookup, not a scan of every node on each store update.
 */
export function setupHolds(nodes: readonly CanvasNode[] | undefined): ReadonlyMap<string, SetupHold> {
  if (!nodes) return EMPTY
  if (nodes !== heldFrom) {
    heldFrom = nodes
    held = new Map()
    for (const n of nodes) {
      const hold = setupHoldOf(n)
      if (hold) held.set(n.id, hold)
    }
  }
  return held
}
const EMPTY: ReadonlyMap<string, SetupHold> = new Map()
