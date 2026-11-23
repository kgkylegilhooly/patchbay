import type { AgentStatus } from '../../shared/model'
import type { Look } from './status'

/**
 * Just after Patchbay opens, the agents it had are being taken on again (joined in the session host, or started
 * again), and for a few seconds most have no status yet. "No status yet" then reads as something wrong; it's only
 * Patchbay catching up. So for a short while after launch an agent that was already there, with no status yet, says
 * "Reconnecting…". After that, or once it has a status, its own words stand. See docs/plans/r3-start.md.
 */
export const SETTLE_MS = 10_000

export const RECONNECTING: Look = { tone: 'pending', label: 'Reconnecting…', detail: 'Reconnecting…\nPatchbay just opened and is catching up with this agent' }

/** Pure: whether an agent shows Reconnecting. `stopped` is a stop its turn ended on, which says more. */
export function isReconnecting(settling: boolean, atLaunch: boolean, status: AgentStatus | null | undefined, stopped: boolean): boolean {
  return settling && atLaunch && !stopped && (status === 'unknown' || status === null || status === undefined)
}
