import type { RunResult } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import { useAgentStop } from '../agentStops'
import { agentLook, runLook, type Look } from '../status/status'
import { setupHolds, type SetupHold } from '../status/setupStatus'
import { useStore } from '../store'
import { StatusMark, StatusText } from '../status/StatusMarks'
import { failedStart } from '../status/startFailure'
import type { NodeError } from '../../shared/contract'
import { RECONNECTING } from '../status/launchSettle'
import { useReconnecting, watchLaunch } from '../status/launchSettleUi'

// From the first canvas the window has: the agents it reopens say Reconnecting for a moment. See launchSettle.ts.
watchLaunch()

/** The start error an agent is stopped on, if it couldn't start. See startFailure.ts. */
export function useStartFailure(status: AgentStatus | null, nodeId?: string): NodeError | null {
  return useStore((s) => (nodeId ? failedStart(status, s.errors[nodeId]) : null))
}

/** A recipe agent's hold for its setup commands, if it has one. */
export function useSetupHold(nodeId?: string): SetupHold | undefined {
  return useStore((s) => (nodeId ? setupHolds(s.doc?.nodes).get(nodeId) : undefined))
}

/** An agent's look, with the stop its turn ended on when the status is still the `unknown` it left. */
export function useAgentLook(status: AgentStatus | null, nodeId?: string): Look {
  const stop = useAgentStop(status === 'unknown' ? nodeId : undefined)
  const setup = useSetupHold(nodeId)
  const failed = useStartFailure(status, nodeId)
  const reconnecting = useReconnecting(status, nodeId, !!stop || !!setup)
  return reconnecting ? RECONNECTING : agentLook(status, stop, Date.now(), setup, failed)
}

/** The mark beside a window's title. A plain terminal has no status, so it gets the small grey square. */
export function StatusDot({ status, nodeId }: { status: AgentStatus | null; nodeId?: string }): React.JSX.Element {
  const look = useAgentLook(status, nodeId)
  return <StatusMark look={look} className={status ? `badge-${status}` : 'badge-terminal'} />
}

/**
 * The words for the status. An agent whose turn ended on StopFailure still has the status `unknown`, but what the
 * hook said is shown instead, such as "Usage limit until 00:30".
 */
export function StatusBadge({ status, nodeId, compact }: { status: AgentStatus; nodeId?: string; compact?: boolean }): React.JSX.Element {
  const stop = useAgentStop(status === 'unknown' ? nodeId : undefined)
  const setup = useSetupHold(nodeId)
  const failed = useStartFailure(status, nodeId)
  const reconnecting = useReconnecting(status, nodeId, !!stop || !!setup)
  return <StatusText look={reconnecting ? RECONNECTING : agentLook(status, stop, Date.now(), setup, failed)} data-reconnecting={reconnecting ? '' : undefined} compact={compact} className={`badge-${status}`} data-stop={stop?.kind} data-setup={setup} data-start-failed={failed ? failed.fix ?? 'none' : undefined} />
}

/** A run command's mark. */
export function RunDot({ run }: { run: RunResult | undefined }): React.JSX.Element {
  return <StatusMark look={runLook(run)} />
}

/** A run command's words. Keeps `run-label`, which tests and scripts look for, and `run-label-failed` on a failure. */
export function RunLabel({ run }: { run: RunResult | undefined }): React.JSX.Element {
  const look = runLook(run)
  return <StatusText look={look} className={`run-label${look.tone === 'held' ? ' run-label-failed' : ''}`} />
}
