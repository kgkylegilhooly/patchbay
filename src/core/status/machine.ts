import type { AgentStatus } from '../../shared/model'

export type StatusEvent =
  | { type: 'hook'; name: string; notificationType?: string; reason?: string }
  | { type: 'interrupt-key' }
  | { type: 'process-exit' }
  | { type: 'launched' }
  /** Held back by --after, not launched yet. */
  | { type: 'queued' }
  /** The user pressed Approve or Deny, so Claude has what it was waiting for. */
  | { type: 'approval-answered' }

const NEEDS_INPUT = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])
/** These end one conversation inside a process that keeps running (as /clear does). */
const SESSION_END_NOT_EXIT = new Set(['clear', 'resume'])

function afterHook(cur: AgentStatus, ev: Extract<StatusEvent, { type: 'hook' }>): AgentStatus {
  switch (ev.name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'Stop':
      return 'idle'
    case 'StopFailure':
      return 'unknown'
    case 'PermissionRequest':
      return 'needs-you'
    case 'Notification':
      return ev.notificationType && NEEDS_INPUT.has(ev.notificationType) ? 'needs-you' : cur
    case 'SessionStart':
      return cur === 'starting' ? 'idle' : cur
    case 'SessionEnd':
      return ev.reason && SESSION_END_NOT_EXIT.has(ev.reason) ? cur : 'exited'
    default:
      return cur
  }
}

/** Pure. Anything it can't vouch for leaves the status alone or makes it `unknown`; it never guesses. */
export function nextStatus(cur: AgentStatus, ev: StatusEvent): AgentStatus {
  switch (ev.type) {
    case 'launched':
      return 'starting'
    case 'queued':
      return 'queued'
    case 'process-exit':
      return 'exited'
    case 'interrupt-key':
      // Claude fires no hook for an interrupt, so nothing says what it's doing now.
      return cur === 'working' || cur === 'needs-you' ? 'unknown' : cur
    case 'approval-answered':
      return cur === 'needs-you' ? 'working' : cur
    case 'hook':
      return cur === 'exited' ? cur : afterHook(cur, ev)
  }
}
