import { isProjectArchived, isProjectOpen, isSessionNode, type CanvasDoc, type Project } from '../shared/model'
import type { ArchivePreview, ProjectStats } from '../shared/projects'

type Ready = Extract<ArchivePreview, { ok: true }>

export type ProjectState = 'open' | 'closed' | 'archived'
export type SortKey = 'order' | 'name' | 'state' | 'nodes' | 'sessions' | 'lastActive' | 'storage'

export interface ProjectRow {
  project: Project
  /** Where its tab is, counting every project, for sorting by tab order. */
  order: number
  state: ProjectState
  active: boolean
  nodes: number
  sessions: number
  running: number | null
  lastActiveAt: number | null
  scrollbackBytes: number | null
  /** Days unused, when it's past the suggestion threshold and could be archived. */
  unusedDays: number | null
}

const DAY = 24 * 3600_000

export function stateOf(p: Project): ProjectState {
  return isProjectArchived(p) ? 'archived' : isProjectOpen(p) ? 'open' : 'closed'
}

/**
 * One row per project, with what main measured when it's arrived. A project is flagged as unused only when the
 * person turned suggestions on, it isn't on screen or already archived, and its last use is known and old enough.
 */
export function projectRows(doc: CanvasDoc, stats: ProjectStats[] | null, suggestDays: number, now: number): ProjectRow[] {
  const byId = new Map((stats ?? []).map((s) => [s.id, s]))
  return doc.projects.map((project, order) => {
    const mine = doc.nodes.filter((n) => n.projectId === project.id)
    const s = byId.get(project.id)
    const state = stateOf(project)
    const active = project.id === doc.activeProjectId
    const lastActiveAt = s?.lastActiveAt ?? null
    const days = lastActiveAt === null ? null : Math.floor((now - lastActiveAt) / DAY)
    const flagged = suggestDays > 0 && !active && state !== 'archived' && days !== null && days >= suggestDays
    return {
      project,
      order,
      state,
      active,
      nodes: mine.length,
      sessions: mine.filter(isSessionNode).length,
      running: s ? s.running : null,
      lastActiveAt,
      scrollbackBytes: s ? s.scrollbackBytes : null,
      unusedDays: flagged ? days : null
    }
  })
}

const STATE_RANK: Record<ProjectState, number> = {
  open: 0,
  closed: 1,
  archived: 2
}

/** Sorted by a column. Unknown values sort last either way, and ties keep tab order. */
export function sortRows(rows: ProjectRow[], key: SortKey, descending: boolean): ProjectRow[] {
  const value = (r: ProjectRow): number | string | null => {
    switch (key) {
      case 'order':
        return r.order
      case 'name':
        return r.project.name.toLowerCase()
      case 'state':
        return STATE_RANK[r.state]
      case 'nodes':
        return r.nodes
      case 'sessions':
        return r.sessions
      case 'lastActive':
        return r.lastActiveAt
      case 'storage':
        return r.scrollbackBytes
    }
  }
  return [...rows].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va === null || vb === null) return va === vb ? a.order - b.order : va === null ? 1 : -1
    const cmp = va < vb ? -1 : va > vb ? 1 : 0
    return (descending ? -cmp : cmp) || a.order - b.order
  })
}

/** "today", "yesterday", "12 days ago", "3 months ago". */
export function daysAgo(at: number | null, now: number): string {
  if (at === null) return '—'
  const days = Math.floor((now - at) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  return `${Math.floor(days / 30)} months ago`
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function names(items: Array<{ title: string }>, most = 4): string {
  const shown = items.slice(0, most).map((i) => `“${i.title}”`)
  const more = items.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** What archiving this project will do, in its own words, worked out by main from what is true now. */
export function archiveLines(p: Ready): string[] {
  const lines: string[] = []
  const agents = p.sessions.filter((s) => s.kind === 'claude')
  const others = p.sessions.filter((s) => s.kind !== 'claude')
  const running = p.sessions.filter((s) => s.running)
  if (running.length) lines.push(`Stops ${plural(running.length, 'running session')}: ${names(running)}.`)
  else if (p.sessions.length) lines.push('None of its sessions is running, so nothing needs stopping.')
  const resumable = agents.filter((a) => a.resumable)
  if (resumable.length) {
    lines.push(
      `${resumable.length === 1 ? 'Its agent keeps its' : `Its ${resumable.length} agents keep their`} conversation and resume${resumable.length === 1 ? 's' : ''} when you start ${resumable.length === 1 ? 'it' : 'them'} again. Transcripts are never deleted.`
    )
  }
  if (others.length && !running.length)
    lines.push(`Its ${plural(others.length, 'terminal or run command', 'terminals and run commands')} stay stopped until you start them.`)
  if (p.browsers.length) lines.push(`Closes ${plural(p.browsers.length, 'browser page')}. Each opens its address again when the project is back.`)
  if (p.triggers.length)
    lines.push(`Disarms ${plural(p.triggers.length, 'trigger')}: ${names(p.triggers)}. Arm ${p.triggers.length === 1 ? 'it' : 'them'} again after unarchiving.`)
  const kept = [
    p.kept.notes ? plural(p.kept.notes, 'note') : '',
    p.kept.whiteboards ? plural(p.kept.whiteboards, 'whiteboard') : '',
    p.kept.groups ? plural(p.kept.groups, 'group') : '',
    p.kept.board ? 'its board' : ''
  ].filter(Boolean)
  lines.push(`Keeps every node${kept.length ? `, ${kept.join(', ')}` : ''} and the layout, as they are.`)
  lines.push('It leaves the tabs and the closed list. Projects… in the File menu lists it, to unarchive.')
  return lines
}
