import type { CanvasDoc, ClaudeNode } from '../shared/model'

const agentsIn = (doc: CanvasDoc | null): ClaudeNode[] => (doc?.nodes ?? []).filter((n): n is ClaudeNode => n.kind === 'claude')

const inside = (folder: string, root: string): boolean => {
  const f = folder.replace(/[\\/]+$/, '').toLowerCase()
  const r = root.replace(/[\\/]+$/, '').toLowerCase()
  return f === r || f.startsWith(`${r}\\`) || f.startsWith(`${r}/`)
}

/** Agents working in this repository come first, since they're who a review is usually for. */
export function reviewTargets(doc: CanvasDoc | null, root: string): ClaudeNode[] {
  const agents = agentsIn(doc)
  return [...agents.filter((a) => inside(a.cwd, root)), ...agents.filter((a) => !inside(a.cwd, root))]
}

/** Agents linked to this browser come first: they're usually the ones building the page. */
export function designTargets(doc: CanvasDoc | null, browserId: string): ClaudeNode[] {
  const agents = agentsIn(doc)
  const linked = new Set((doc?.edges ?? []).flatMap((e) => (e.from === browserId ? [e.to] : e.to === browserId ? [e.from] : [])))
  return [...agents.filter((a) => linked.has(a.id)), ...agents.filter((a) => !linked.has(a.id))]
}
