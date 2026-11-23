import { isSessionNode, type AgentStatus, type CanvasDoc } from '../shared/model'
import type { Tone } from './status/status'
import type { NodeError, RunResult } from '../shared/contract'
import { sessionBlocked } from './status/setupStatus'

export function projectSessions(doc: CanvasDoc, projectId: string): string[] {
  return doc.nodes.filter((n) => n.projectId === projectId && isSessionNode(n)).map((n) => n.id)
}

export type ProjectSignal = 'needs-you' | 'stopped' | 'unseen' | 'working'

/**
 * What a project's tab should show: someone waiting on you, then an agent stopped on a limit or an error, then
 * something to look at, then work still going. `stopped` holds the agents whose turn ended on an API error.
 */
export function projectSignal(doc: CanvasDoc, statuses: Record<string, AgentStatus>, projectId: string, attention: string[] = [], stopped: Record<string, unknown> = {}, runs: Record<string, RunResult> = {}, errors: Record<string, NodeError> = {}): ProjectSignal | null {
  const sessions = projectSessions(doc, projectId)
  const seen = sessions.map((id) => statuses[id])
  if (seen.includes('needs-you')) return 'needs-you'
  if (sessions.some((id) => statuses[id] === 'unknown' && id in stopped)) return 'stopped'
  // A recipe agent whose setup failed, or a failed run command not yet looked at: held too, as the Status tab says.
  if (doc.nodes.some((n) => n.projectId === projectId && isSessionNode(n) && sessionBlocked(n, statuses[n.id], runs[n.id], attention.includes(n.id), errors[n.id]))) return 'stopped'
  if (sessions.some((id) => attention.includes(id))) return 'unseen'
  return seen.includes('working') ? 'working' : null
}

/** The status system's tone for a signal. Unseen has none: it's the white unread marker. */
export const SIGNAL_TONE: Record<ProjectSignal, Tone | null> = { 'needs-you': 'needs', stopped: 'held', unseen: null, working: 'working' }
