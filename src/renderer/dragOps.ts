import { reduce } from '../core/canvas/reduce'
import { inActiveProject, type CanvasDoc, type CanvasOp } from '../shared/model'
import { dropParent } from './flowMapping'
import { absolutePosition } from './newNodes'

export interface MovedNode {
  id: string
  /** Where the node ended up on the canvas. */
  abs: { x: number; y: number }
  /** The same spot, relative to its current parent. */
  rel: { x: number; y: number }
}

/**
 * The ops for a finished drag. A node dropped into or out of a group changes parent first. The
 * reducer may then move that group to fit, so the node's new relative position has to come from
 * where the group is after that step, which is why this replays each op as it goes.
 */
export function dragOps(doc: CanvasDoc, moved: MovedNode[]): CanvasOp[] {
  const ops: CanvasOp[] = []
  const draggedIds = new Set(moved.map((m) => m.id))
  let sim = doc
  const apply = (op: CanvasOp): void => {
    ops.push(op)
    sim = reduce(sim, op)
  }

  for (const m of moved) {
    const node = sim.nodes.find((n) => n.id === m.id)
    if (!node) continue
    const parentDragged = node.parentId !== null && draggedIds.has(node.parentId)
    if (node.kind === 'group' || parentDragged) {
      apply({ op: 'patchNode', id: m.id, patch: { x: m.rel.x, y: m.rel.y } })
      continue
    }
    const groups = sim.nodes
      // A group in another project isn't on screen, so nothing can be dropped into it.
      .filter((n) => n.kind === 'group' && !draggedIds.has(n.id) && inActiveProject(sim, n))
      .map((g) => ({ id: g.id, width: g.width, height: g.height, ...absolutePosition(sim, g) }))
    const target = dropParent({ ...m.abs, width: node.width, height: node.height }, groups)
    if (target === node.parentId) {
      apply({ op: 'patchNode', id: m.id, patch: { x: m.rel.x, y: m.rel.y } })
      continue
    }
    apply({ op: 'setParent', ids: [m.id], parentId: target })
    const parent = target ? sim.nodes.find((n) => n.id === target) : undefined
    const origin = parent ? absolutePosition(sim, parent) : { x: 0, y: 0 }
    apply({ op: 'patchNode', id: m.id, patch: { x: m.abs.x - origin.x, y: m.abs.y - origin.y } })
  }
  return ops
}
