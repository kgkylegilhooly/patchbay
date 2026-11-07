import { isSessionNode, whereShown, type CanvasDoc, type GroupNode, type SessionNode } from '../shared/model'

export type Session = SessionNode

export interface SessionTree {
  groups: { group: GroupNode; sessions: Session[] }[]
  ungrouped: Session[]
  /** Every session, whatever the filter hides. */
  total: number
}

const isSession = isSessionNode

export function matchesSession(session: Session, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || session.title.toLowerCase().includes(q) || whereShown(session).toLowerCase().includes(q)
}

/** One project's sessions, grouped for the sidebar. A session in a nested group lists under its own group. */
export function sessionTree(doc: CanvasDoc, query: string, projectId: string = doc.activeProjectId): SessionTree {
  const here = doc.nodes.filter((n) => !n.projectId || n.projectId === projectId)
  const all = here.filter(isSession)
  const shown = all.filter((s) => matchesSession(s, query))
  const groups = here
    .filter((n): n is GroupNode => n.kind === 'group')
    .map((group) => ({ group, sessions: shown.filter((s) => s.parentId === group.id) }))
    .filter((g) => g.sessions.length > 0)
  const listed = new Set(groups.flatMap((g) => g.sessions.map((s) => s.id)))
  return { groups, ungrouped: shown.filter((s) => !listed.has(s.id)), total: all.length }
}
