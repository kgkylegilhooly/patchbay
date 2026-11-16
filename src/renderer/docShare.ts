import type { CanvasDoc } from '../shared/model'
import type { FlowEdge } from './flowMapping'

/**
 * Each doc from main is a fresh copy, so nothing in it is the same object as before even when it hasn't changed. That
 * made every window on the canvas draw again on every change anywhere. These put back the objects from before
 * wherever the content is the same, so only what changed draws again.
 */

/** Whether two values from a doc hold the same content. The same object is answered at once. */
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    if (a.length !== other.length) return false
    for (let i = 0; i < a.length; i++) if (!sameContent(a[i], other[i])) return false
    return true
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!sameContent((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

/** The list from before if it holds the same items, else the new one with each unchanged item kept from before. */
function shareList<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const old = new Map(prev.map((x) => [x.id, x]))
  let all = prev.length === next.length
  const out = next.map((x, i) => {
    const before = old.get(x.id)
    const kept = before && sameContent(before, x) ? before : x
    if (kept !== prev[i]) all = false
    return kept
  })
  return all ? prev : out
}

/** The new doc, with every node, edge, project and closed session that hasn't changed kept as the object it was. */
export function shareDoc(prev: CanvasDoc | null, next: CanvasDoc): CanvasDoc {
  if (!prev) return next
  const doc: CanvasDoc = {
    ...next,
    nodes: shareList(prev.nodes, next.nodes),
    edges: shareList(prev.edges, next.edges),
    projects: shareList(prev.projects, next.projects),
    closed: shareList(prev.closed, next.closed),
    viewport: sameContent(prev.viewport, next.viewport) ? prev.viewport : next.viewport
  }
  // Nothing at all changed, as when only the order of saving moved on: the doc from before, so nothing draws.
  const keys = Object.keys(doc) as Array<keyof CanvasDoc>
  return keys.every((k) => doc[k] === prev[k] || sameContent(doc[k], prev[k])) && keys.length === Object.keys(prev).length ? prev : doc
}

/** Cables from before, kept where nothing about them changed, with the person's selection carried over. */
export function shareEdges(prev: FlowEdge[], next: FlowEdge[]): FlowEdge[] {
  const old = new Map(prev.map((e) => [e.id, e]))
  let all = prev.length === next.length
  const out = next.map((e, i) => {
    const before = old.get(e.id)
    const merged = before?.selected ? { ...e, selected: true } : e
    const kept = before && sameContent(before, merged) ? before : merged
    if (kept !== prev[i]) all = false
    return kept
  })
  return all ? prev : out
}
