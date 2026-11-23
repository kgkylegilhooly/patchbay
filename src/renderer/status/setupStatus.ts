import type { AgentStatus, CanvasNode } from '../../shared/model'
import type { RunResult } from '../../shared/contract'
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
 * whose setup failed, or a run command that exited with an error. The Status tab lists these under Need attention.
 */
export function sessionBlocked(node: CanvasNode, status: AgentStatus | null | undefined, run: RunResult | undefined): boolean {
  if (node.kind === 'run') return !!run && !run.running && !run.stoppedByYou && run.exitCode !== null && run.exitCode !== 0
  return setupLookFor(status, setupHoldOf(node))?.tone === 'held'
}
