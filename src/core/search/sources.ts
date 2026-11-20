import type { NodeMessage } from '../../shared/contract'
import type { CanvasDoc, ClosedSession } from '../../shared/model'
import type { SourceSpec, SyncInput } from './types'

/** Windows paths differ only in case and slashes, and are the same file. */
export const conversationKey = (path: string): string => `conv:${path.replace(/\//g, '\\').toLowerCase()}`

/** The closed conversation a removed node left behind, found by the id it was given. */
function closedOf(closed: ClosedSession[], nodeId: string): ClosedSession | undefined {
  for (let i = closed.length - 1; i >= 0; i--) if (closed[i].id.startsWith(`closed-${nodeId}-`)) return closed[i]
  return undefined
}

/** A note's text as searched: its title too, unless that's only the default. */
const noteText = (title: string, text: string): string => (title && title !== 'Note' ? `${title}\n${text}` : text)

/**
 * Everything search can find, from the canvas and the retained messages. Agent windows and closed conversations are
 * read from their transcripts; notes and messages carry their text. `extra` comes from registered sources, such as
 * task results. A conversation open on the canvas wins over the closed entry it was reopened from.
 */
export function searchSources(doc: CanvasDoc, messages: NodeMessage[], now: number, extra: SourceSpec[] = []): SyncInput {
  const sources: SourceSpec[] = []
  const keys = new Set<string>()
  const add = (s: SourceSpec): void => {
    if (keys.has(s.key)) return
    keys.add(s.key)
    sources.push(s)
  }
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]))

  for (const n of doc.nodes) {
    if (n.kind !== 'claude' || !n.transcriptPath) continue
    add({ kind: 'conversation', key: conversationKey(n.transcriptPath), title: n.title, ref: { type: 'node', nodeId: n.id }, path: n.transcriptPath, cwd: n.cwd, ...(n.projectId ? { projectId: n.projectId } : {}), ...(n.agent ? { agent: n.agent } : {}) })
  }
  for (const c of [...doc.closed].reverse()) {
    if (!c.transcriptPath) continue
    add({ kind: 'conversation', key: conversationKey(c.transcriptPath), title: c.title, ref: { type: 'closed', closedId: c.id }, path: c.transcriptPath, cwd: c.cwd, at: c.closedAt, ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.agent ? { agent: c.agent } : {}) })
  }
  for (const n of doc.nodes) {
    if (n.kind !== 'sticky' || !n.text.trim()) continue
    add({ kind: 'note', key: `note:${n.id}`, title: n.title === 'Note' ? (n.text.split('\n').map((l) => l.replace(/^[\s#>*+-]*/, '').trim()).find(Boolean) ?? 'Note').slice(0, 80) : n.title, ref: { type: 'node', nodeId: n.id }, at: now, text: noteText(n.title, n.text), ...(n.projectId ? { projectId: n.projectId } : {}) })
  }
  const seen = new Map<string, number>()
  for (const m of messages) {
    const base = `msg:${m.at}:${m.from}:${m.to}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const name = (id: string): string => nodes.get(id)?.title ?? closedOf(doc.closed, id)?.title ?? 'a closed window'
    const projectId = nodes.get(m.to)?.projectId ?? nodes.get(m.from)?.projectId ?? closedOf(doc.closed, m.to)?.projectId ?? closedOf(doc.closed, m.from)?.projectId
    add({ kind: 'message', key: count ? `${base}:${count}` : base, title: `${name(m.from)} to ${name(m.to)}`, ref: { type: 'message', from: m.from, to: m.to, at: m.at }, at: m.at, text: m.text, ...(projectId ? { projectId } : {}) })
  }
  for (const s of extra) add(s)

  return { sources, projects: Object.fromEntries(doc.projects.map((p) => [p.id, p.name])) }
}
