import type { RunResult } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import { useAgentStop } from '../agentStops'
import { agentLook, runLook, type Look } from '../status/status'
import { setupHoldOf, type SetupHold } from '../status/setupStatus'
import { useStore } from '../store'
import { StatusMark, StatusText } from '../status/StatusMarks'

/** A recipe agent's hold for its setup commands, if it has one. */
export function useSetupHold(nodeId?: string): SetupHold | undefined {
  return useStore((s) => (nodeId ? setupHoldOf(s.doc?.nodes.find((n) => n.id === nodeId)) : undefined))
}

/** An agent's look, with the stop its turn ended on when the status is still the `unknown` it left. */
export function useAgentLook(status: AgentStatus | null, nodeId?: string): Look {
  const stop = useAgentStop(status === 'unknown' ? nodeId : undefined)
  return agentLook(status, stop, Date.now(), useSetupHold(nodeId))
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
export function StatusBadge({ status, nodeId }: { status: AgentStatus; nodeId?: string }): React.JSX.Element {
  const stop = useAgentStop(status === 'unknown' ? nodeId : undefined)
  const setup = useSetupHold(nodeId)
  return <StatusText look={agentLook(status, stop, Date.now(), setup)} className={`badge-${status}`} data-stop={stop?.kind} data-setup={setup} />
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
