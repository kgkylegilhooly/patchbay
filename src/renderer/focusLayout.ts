/** A focus view layout: windows side by side or stacked, split as far as the person likes. */
export type Pane = { type: 'leaf'; nodeId: string | null } | { type: 'split'; dir: 'row' | 'column'; ratio: number; a: Pane; b: Pane }

/** Which way to go from the root to a pane: 'a' or 'b' at each split. */
export type PanePath = Array<'a' | 'b'>

export const MIN_RATIO = 0.12

const leaf = (nodeId: string | null): Pane => ({ type: 'leaf', nodeId })
const split = (dir: 'row' | 'column', a: Pane, b: Pane, ratio = 0.5): Pane => ({ type: 'split', dir, ratio, a, b })

export function paneAt(root: Pane, path: PanePath): Pane | null {
  let at: Pane = root
  for (const step of path) {
    if (at.type !== 'split') return null
    at = at[step]
  }
  return at
}

function replaceAt(root: Pane, path: PanePath, change: (p: Pane) => Pane): Pane {
  if (path.length === 0) return change(root)
  if (root.type !== 'split') return root
  const [step, ...rest] = path
  return { ...root, [step]: replaceAt(root[step], rest, change) }
}

/** Splits a pane in two. The new half starts empty, or with the given window. */
export function splitPane(root: Pane, path: PanePath, dir: 'row' | 'column', nodeId: string | null = null): Pane {
  return replaceAt(root, path, (p) => split(dir, p, leaf(nodeId)))
}

/** Closing a pane gives its space to the one beside it. The last pane can't be closed, only emptied. */
export function closePane(root: Pane, path: PanePath): Pane {
  if (path.length === 0) return leaf(null)
  const parentPath = path.slice(0, -1)
  const side = path[path.length - 1]
  return replaceAt(root, parentPath, (p) => (p.type === 'split' ? (side === 'a' ? p.b : p.a) : p))
}

/** Shows a window in a pane. A window shows in one pane at a time, so it leaves any other pane it was in. */
export function showIn(root: Pane, path: PanePath, nodeId: string | null): Pane {
  const cleared = nodeId ? clearNode(root, nodeId) : root
  return replaceAt(cleared, path, () => leaf(nodeId))
}

function clearNode(p: Pane, nodeId: string): Pane {
  if (p.type === 'leaf') return p.nodeId === nodeId ? leaf(null) : p
  return { ...p, a: clearNode(p.a, nodeId), b: clearNode(p.b, nodeId) }
}

export function setRatio(root: Pane, path: PanePath, ratio: number): Pane {
  const r = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio))
  return replaceAt(root, path, (p) => (p.type === 'split' ? { ...p, ratio: r } : p))
}

/** Every pane in reading order, with its path. */
export function leaves(root: Pane, path: PanePath = []): Array<{ path: PanePath; nodeId: string | null }> {
  if (root.type === 'leaf') return [{ path, nodeId: root.nodeId }]
  return [...leaves(root.a, [...path, 'a']), ...leaves(root.b, [...path, 'b'])]
}

/** Windows that are gone leave their panes empty, and a saved layout that's broken is replaced. */
export function prune(root: unknown, exists: (id: string) => boolean): Pane | null {
  const clean = (p: unknown, depth: number): Pane | null => {
    if (depth > 12 || typeof p !== 'object' || p === null) return null
    const v = p as Record<string, unknown>
    if (v.type === 'leaf') return leaf(typeof v.nodeId === 'string' && exists(v.nodeId) ? v.nodeId : null)
    if (v.type !== 'split' || (v.dir !== 'row' && v.dir !== 'column')) return null
    const a = clean(v.a, depth + 1)
    const b = clean(v.b, depth + 1)
    if (!a || !b) return null
    const ratio = typeof v.ratio === 'number' && Number.isFinite(v.ratio) ? Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, v.ratio)) : 0.5
    return split(v.dir, a, b, ratio)
  }
  return clean(root, 0)
}

/** A first layout for some windows: one fills the view, two sit side by side, and more make a grid. */
export function initialLayout(ids: string[]): Pane {
  const [a = null, b, c, d] = ids
  if (b === undefined) return leaf(a)
  if (c === undefined) return split('row', leaf(a), leaf(b))
  if (d === undefined) return split('row', leaf(a), split('column', leaf(b), leaf(c)))
  return split('row', split('column', leaf(a), leaf(b)), split('column', leaf(c), leaf(d)))
}

/** Adds a window: into the first empty pane, or by splitting the last pane beside it. */
export function addWindow(root: Pane, nodeId: string): Pane {
  const all = leaves(root)
  if (all.some((l) => l.nodeId === nodeId)) return root
  const empty = all.find((l) => l.nodeId === null)
  if (empty) return showIn(root, empty.path, nodeId)
  const last = all[all.length - 1]
  return splitPane(root, last.path, last.path.length % 2 === 0 ? 'row' : 'column', nodeId)
}
