import type { CanvasDoc } from './model'

/**
 * The nodes whose saved output (scrollback) is kept: terminals and runs on the canvas, and those in the closed list, so
 * Reopen brings their output back (F48). Anything else's is removed once it's in neither.
 */
export function outputKeptFor(doc: Pick<CanvasDoc, 'nodes' | 'closedShells'>): Set<string> {
  const ids = new Set<string>()
  for (const n of doc.nodes) if (n.kind === 'terminal' || n.kind === 'run') ids.add(n.id)
  for (const s of doc.closedShells ?? []) ids.add(s.node.id)
  return ids
}
