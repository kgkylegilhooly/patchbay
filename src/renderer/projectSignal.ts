import { isSessionNode, type AgentStatus, type CanvasDoc } from '../shared/model'

export function projectSessions(doc: CanvasDoc, projectId: string): string[] {
  return doc.nodes.filter((n) => n.projectId === projectId && isSessionNode(n)).map((n) => n.id)
}

/** What a project's tab should show: someone waiting on you, then something to look at, then work still going. */
export function projectSignal(doc: CanvasDoc, statuses: Record<string, AgentStatus>, projectId: string, attention: string[] = []): 'needs-you' | 'unseen' | 'working' | null {
  const sessions = projectSessions(doc, projectId)
  const seen = sessions.map((id) => statuses[id])
  if (seen.includes('needs-you')) return 'needs-you'
  if (sessions.some((id) => attention.includes(id))) return 'unseen'
  return seen.includes('working') ? 'working' : null
}
