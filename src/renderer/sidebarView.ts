import { isProjectArchived, isProjectOpen, isSessionNode, type AgentStatus, type CanvasDoc, type ClosedSession, type Project } from '../shared/model'
import { matchesSession, sessionTree, type Session, type SessionTree } from './sessionTree'

export type BucketId = 'needs-you' | 'unread' | 'running' | 'idle' | 'unknown' | 'starting' | 'stopped' | 'plain'

/**
 * The Status tab's sections, in order. Each session is in exactly one, the first that applies.
 *
 * Only `idle` from a Claude hook reaches Idle. Queued and starting sessions wait under Starting, ended ones go under
 * Stopped, and terminals and run commands, which have no way of reporting a status, get a section of their own.
 */
export const BUCKETS: { id: BucketId; label: string; help: string; always: boolean }[] = [
  { id: 'needs-you', label: 'Need attention', help: 'Waiting on you to answer', always: true },
  { id: 'unread', label: 'Unread', help: "Finished or stopped, and you haven't looked yet", always: false },
  { id: 'running', label: 'Running', help: 'Claude is working', always: false },
  { id: 'idle', label: 'Idle', help: 'Claude finished its turn', always: false },
  { id: 'unknown', label: 'No status yet', help: "Patchbay can't tell, so don't assume it finished", always: false },
  { id: 'starting', label: 'Starting', help: 'Queued, or on its way up', always: false },
  { id: 'stopped', label: 'Stopped', help: 'The process has ended', always: false },
  { id: 'plain', label: 'Terminals and commands', help: "These don't report a status, so none is shown", always: false }
]

/** Never guesses: anything with no status from a hook is either Unknown or listed as having none. */
export function bucketOf(kind: Session['kind'], status: AgentStatus | null, unread: boolean, stopped = false): BucketId {
  if (status === 'needs-you') return 'needs-you'
  // Stopped at a usage limit, a failed login or an API error: Patchbay knows why, so it isn't Unknown.
  if (status === 'unknown' && stopped) return 'needs-you'
  if (unread) return 'unread'
  switch (status) {
    case 'working':
      return 'running'
    case 'idle':
      return 'idle'
    case 'unknown':
      return 'unknown'
    case 'queued':
    case 'starting':
      return 'starting'
    case 'exited':
      return 'stopped'
    case null:
      return kind === 'claude' ? 'unknown' : 'plain'
  }
}

export interface StatusSection {
  id: BucketId
  label: string
  help: string
  sessions: Session[]
}

/**
 * Every session, by status, across projects. A closed project is out of sight on purpose, except for what the taskbar
 * badge is counting: a session waiting on you has to stay findable, wherever it is.
 */
export function statusSections(doc: CanvasDoc, statuses: Record<string, AgentStatus>, attention: string[], query: string, stopped: Record<string, unknown> = {}): StatusSection[] {
  const open = new Map(doc.projects.map((p) => [p.id, isProjectOpen(p)]))
  const names = new Map(doc.projects.map((p) => [p.id, p.name.toLowerCase()]))
  const q = query.trim().toLowerCase()
  const shown = (s: Session): boolean => matchesSession(s, query) || (!!s.projectId && !!names.get(s.projectId)?.includes(q))
  const unread = new Set(attention)
  const sections = new Map<BucketId, Session[]>(BUCKETS.map((b) => [b.id, []]))
  for (const node of doc.nodes) {
    if (!isSessionNode(node) || !shown(node)) continue
    const bucket = bucketOf(node.kind, statuses[node.id] ?? null, unread.has(node.id), node.id in stopped)
    const hidden = node.projectId !== undefined && open.get(node.projectId) === false
    if (hidden && bucket !== 'needs-you' && bucket !== 'unread') continue
    // An archived project's sessions were stopped on purpose, and can't be shown until it's unarchived.
    if (hidden && isProjectArchived(doc.projects.find((p) => p.id === node.projectId))) continue
    sections.get(bucket)!.push(node)
  }
  return BUCKETS.filter((b) => b.always || sections.get(b.id)!.length > 0).map((b) => ({ id: b.id, label: b.label, help: b.help, sessions: sections.get(b.id)! }))
}

export interface ProjectSection {
  project: Project
  tree: SessionTree
  /** What's showing under the filter. */
  count: number
}

/** The open projects in tab order. With a filter, only those holding a match. */
export function projectSections(doc: CanvasDoc, query: string): ProjectSection[] {
  const sections = doc.projects.filter(isProjectOpen).map((project) => {
    const tree = sessionTree(doc, query, project.id)
    const count = tree.ungrouped.length + tree.groups.reduce((sum, g) => sum + g.sessions.length, 0)
    return { project, tree, count }
  })
  return query.trim() ? sections.filter((s) => s.count > 0) : sections
}

/** Closed projects, the most recently closed first. */
export function closedProjects(doc: CanvasDoc): Project[] {
  return doc.projects.filter((p) => !isProjectOpen(p) && !isProjectArchived(p)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
}

/** The same folder, however it's written: case, slash direction and a trailing slash don't count. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (f: string): string => f.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Whether a sidebar row shows its folder line. Under its own project's heading, a session in the project's folder
 * would only repeat it, so the line shows only where the session runs somewhere else. The Status tab always shows
 * it, as it names the row's project there.
 */
export function rowShowsWhere(where: string, project: Project | undefined, tab: 'project' | 'status'): boolean {
  if (tab === 'status') return true
  return !project || !sameFolder(where, project.folder)
}

/** The same history the Closed conversations panel shows, the newest first. */
export function recentlyClosed(doc: CanvasDoc, query: string): ClosedSession[] {
  const q = query.trim().toLowerCase()
  const shown = q ? doc.closed.filter((c) => c.title.toLowerCase().includes(q) || c.cwd.toLowerCase().includes(q)) : doc.closed
  return [...shown].reverse()
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const BADGE_COLORS = ['#49c2c9', '#e2b04a', '#e0689b', '#7fa8ff', '#62dc8a', '#bf7af0', '#ff9f43']

/** A letter tile that stays the same color for a project, whatever else opens or closes. */
export function projectBadge(project: Pick<Project, 'id' | 'name'>): { letter: string; color: string } {
  let hash = 0
  for (const c of project.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  const letter = [...project.name.trim()][0]?.toUpperCase() ?? '?'
  return { letter, color: BADGE_COLORS[hash % BADGE_COLORS.length] }
}
