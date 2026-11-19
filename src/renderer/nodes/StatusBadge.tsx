import type { AgentStatus } from '../../shared/model'
import { stopLabel } from '../../shared/agentStop'
import { useAgentStop } from '../agentStops'

const LABELS: Record<AgentStatus, string> = {
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  exited: 'Exited',
  unknown: 'Unknown'
}

/** The dot beside a window's title. A plain terminal has no status, so it gets its own color. */
export function StatusDot({ status, nodeId }: { status: AgentStatus | null; nodeId?: string }): React.JSX.Element {
  const stop = useAgentStop(status === 'unknown' ? nodeId : undefined)
  const stopped = stop ? ` badge-stopped-dot${stop.holds === 'person' ? ' badge-stopped-person' : ''}` : ''
  return (
    <span className={`badge badge-${status ?? 'terminal'}${stopped}`}>
      <span className="led" aria-hidden="true" />
    </span>
  )
}

/**
 * A word for the status. An agent whose turn ended on StopFailure still has the status `unknown`, but what the hook
 * said is shown instead, such as "Usage limit until 00:30".
 */
export function StatusBadge({ status, nodeId }: { status: AgentStatus; nodeId?: string }): React.JSX.Element {
  const stop = useAgentStop(status === 'unknown' ? nodeId : undefined)
  if (stop) {
    const label = stopLabel(stop, Date.now())
    return (
      <span className={`badge badge-stopped${stop.holds === 'person' ? ' badge-stopped-person' : ''}`} data-stop={stop.kind} title={stop.message ? `${label}\n${stop.message}` : label}>
        {label}
      </span>
    )
  }
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>
}
