import type { CanvasDoc, ClaudeNode, ReaderNode } from '../../shared/model'

const inside = (file: string, folder: string): boolean => {
  const f = file.replace(/\//g, '\\').toLowerCase()
  const d = folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return !!d && f.startsWith(`${d}\\`)
}

/**
 * Who a reader's comments can go to, most likely first: the agent it came from, then agents cabled to it, then agents
 * working in a folder that holds the file, then every other agent.
 */
export function readerTargets(doc: CanvasDoc | null, reader: Pick<ReaderNode, 'id' | 'path' | 'fromNodeId' | 'openedBy'>): ClaudeNode[] {
  const agents = (doc?.nodes ?? []).filter((n): n is ClaudeNode => n.kind === 'claude')
  const linked = new Set((doc?.edges ?? []).flatMap((e) => (e.from === reader.id ? [e.to] : e.to === reader.id ? [e.from] : [])))
  const rank = (a: ClaudeNode): number => {
    if (a.id === reader.fromNodeId || a.id === reader.openedBy) return 0
    if (linked.has(a.id)) return 1
    if (inside(reader.path, a.cwd)) return 2
    return 3
  }
  return agents
    .map((a, i) => ({ a, i, r: rank(a) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.a)
}

/** How long ago, in the words a header shows. */
export function changedAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** A heading's anchor as GitHub makes it, so links like #rollout-plan find their heading. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}
