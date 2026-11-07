import { reduce } from '../core/canvas/reduce'
import type { CanvasDoc, CanvasNode, CanvasOp, LayoutRestore, NodeLayout } from '../shared/model'

/**
 * Undo and redo for how the canvas is laid out: moving, resizing, grouping, arranging, renaming, and adding or deleting
 * a note or group. Nothing here can end or start a session, because undoing only ever sends `restoreLayout`.
 */
export interface HistoryEntry {
  label: string
  undo: LayoutRestore
  redo: LayoutRestore
}

export interface History {
  past: HistoryEntry[]
  future: HistoryEntry[]
}

export const EMPTY_HISTORY: History = { past: [], future: [] }

const LIMIT = 100

const layoutOf = ({ id, x, y, width, height, parentId, title }: CanvasNode): NodeLayout => ({ id, x, y, width, height, parentId, title })

const sameLayout = (a: CanvasNode, b: CanvasNode): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.parentId === b.parentId && a.title === b.title

const isLayoutOnly = (n: CanvasNode): boolean => n.kind === 'sticky' || n.kind === 'group'

/** What it takes to go each way between two docs. Null if the layout didn't change. */
export function diffLayout(before: CanvasDoc, after: CanvasDoc): Pick<HistoryEntry, 'undo' | 'redo'> | null {
  const was = new Map(before.nodes.map((n) => [n.id, n]))
  const now = new Map(after.nodes.map((n) => [n.id, n]))
  const undoPatches: NodeLayout[] = []
  const redoPatches: NodeLayout[] = []
  for (const node of after.nodes) {
    const old = was.get(node.id)
    if (!old || sameLayout(old, node)) continue
    undoPatches.push(layoutOf(old))
    redoPatches.push(layoutOf(node))
  }
  const added = after.nodes.filter((n) => !was.has(n.id) && isLayoutOnly(n))
  const removed = before.nodes.filter((n) => !now.has(n.id) && isLayoutOnly(n))
  const edgeIdsAfter = new Set(after.edges.map((e) => e.id))
  const lostEdges = before.edges.filter((e) => !edgeIdsAfter.has(e.id))
  if (!undoPatches.length && !added.length && !removed.length && !lostEdges.length) return null
  return {
    undo: { patches: undoPatches, add: removed, remove: added.map((n) => n.id), edges: lostEdges },
    redo: { patches: redoPatches, add: added, remove: removed.map((n) => n.id), edges: [] }
  }
}

/** What running these ops would do to the layout, worked out the same way main will. */
export function entryFor(doc: CanvasDoc, label: string, ops: CanvasOp[]): HistoryEntry | null {
  const diff = diffLayout(doc, ops.reduce(reduce, doc))
  return diff && { label, ...diff }
}

export function recordEntry(history: History, entry: HistoryEntry): History {
  return { past: [...history.past, entry].slice(-LIMIT), future: [] }
}

export function stepBack(history: History): { history: History; entry: HistoryEntry } | null {
  const entry = history.past[history.past.length - 1]
  if (!entry) return null
  return { entry, history: { past: history.past.slice(0, -1), future: [...history.future, entry] } }
}

export function stepForward(history: History): { history: History; entry: HistoryEntry } | null {
  const entry = history.future[history.future.length - 1]
  if (!entry) return null
  return { entry, history: { past: [...history.past, entry], future: history.future.slice(0, -1) } }
}
