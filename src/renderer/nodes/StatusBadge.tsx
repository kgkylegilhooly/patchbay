import type { AgentStatus } from '../../shared/model'

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
export function StatusDot({ status }: { status: AgentStatus | null }): React.JSX.Element {
  return (
    <span className={`badge badge-${status ?? 'terminal'}`}>
      <span className="led" aria-hidden="true" />
    </span>
  )
}

export function StatusBadge({ status }: { status: AgentStatus }): React.JSX.Element {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>
}
