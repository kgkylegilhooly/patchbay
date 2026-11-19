import { MarkerType, type Edge as RFEdge, type Node as RFNode } from '@xyflow/react'
import { inActiveProject, isSessionNode, type AgentStatus, type CanvasDoc, type CanvasNode } from '../shared/model'
import { cableDirection, type CableKind } from './cableMotion'

export type FlowData = { node: CanvasNode; status: AgentStatus | null }
export type FlowNode = RFNode<FlowData>
export type FlowEdge = RFEdge<{ kind: CableKind }>

const CABLE_COLORS: Record<CableKind, string> = {
  opened: 'var(--cable-opened)',
  link: 'var(--cable-link)',
  after: 'var(--cable-after)',
  trigger: 'var(--cable-trigger)'
}

function cable(id: string, source: string, target: string, kind: CableKind): FlowEdge {
  const edge: FlowEdge = { id, source, target, type: 'cable', className: `cable-${kind}`, data: { kind }, selectable: kind === 'link' || kind === 'trigger' }
  // Direction still shows with the animation off, as it is for anyone who has asked for less motion.
  if (cableDirection(kind) === 'forward') edge.markerEnd = { type: MarkerType.ArrowClosed, color: CABLE_COLORS[kind], width: 16, height: 16 }
  return edge
}

function toFlowNode(node: CanvasNode, statuses: Record<string, AgentStatus>): FlowNode {
  const status = statuses[node.id] ?? (node.kind === 'claude' ? 'unknown' : null)
  const flow: FlowNode = {
    id: node.id,
    type: node.kind,
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    data: { node, status }
  }
  if (node.parentId) flow.parentId = node.parentId
  if (isSessionNode(node) || node.kind === 'browser' || node.kind === 'whiteboard' || node.kind === 'reader') flow.dragHandle = '.pb-drag'
  if (node.kind === 'group') flow.zIndex = -1
  return flow
}

export const triggerEdgeId = (triggerId: string): string => `trigger:${triggerId}`

/** Draws the project on screen. The order of doc.nodes (parents first) is what React Flow needs. */
export function toFlow(doc: CanvasDoc, statuses: Record<string, AgentStatus>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const hidden = new Set(doc.nodes.filter((n) => !inActiveProject(doc, n)).map((n) => n.id))
  const shown = new Set(doc.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id))
  return {
    nodes: doc.nodes.filter((n) => !hidden.has(n.id)).map((n) => toFlowNode(n, statuses)),
    edges: [
      ...doc.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to)).map((e) => cable(e.id, e.from, e.to, e.kind)),
      // A trigger's target is saved on the trigger. This only draws it, so the two can't disagree.
      ...doc.nodes.flatMap((n) =>
        n.kind === 'trigger' && n.targetId && !hidden.has(n.id) && shown.has(n.targetId) ? [cable(triggerEdgeId(n.id), n.id, n.targetId, 'trigger')] : []
      )
    ]
  }
}

/**
 * Folds a new document into what's on screen. An unchanged node keeps its object, so it doesn't
 * re-render, and a node mid-drag or mid-resize keeps its local geometry until the gesture ends.
 */
export function mergeFlowNodes(prev: FlowNode[], next: FlowNode[]): FlowNode[] {
  const byId = new Map(prev.map((n) => [n.id, n]))
  return next.map((n) => {
    const old = byId.get(n.id)
    if (!old) return n
    if (old.data.node === n.data.node && old.data.status === n.data.status) return old
    const merged: FlowNode = { ...n, selected: old.selected, measured: old.measured, dragging: old.dragging, resizing: old.resizing }
    if (old.dragging || old.resizing) merged.position = old.position
    if (old.resizing) {
      merged.width = old.width
      merged.height = old.height
    }
    return merged
  })
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The group a node was dropped into: the smallest one holding the node's center. */
export function dropParent(node: Rect, groups: Array<Rect & { id: string }>): string | null {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const holding = groups.filter((g) => cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height)
  if (holding.length === 0) return null
  return holding.reduce((a, b) => (b.width * b.height < a.width * a.height ? b : a)).id
}

/** A patch cable hanging between two jacks: out of each jack, then down under its own weight. */
export function cablePath(sx: number, sy: number, tx: number, ty: number): { path: string; midX: number; sagY: number } {
  const distance = Math.hypot(tx - sx, ty - sy)
  const sag = Math.min(150, Math.max(26, distance * 0.2))
  // A short forward span stays a U rather than crossing itself. A backward one loops out of its jacks.
  const span = tx - sx
  const reach = span > 0 ? Math.max(span * 0.3, Math.min(36, span * 0.4)) : Math.max(60, -span * 0.3)
  const path = `M ${sx} ${sy} C ${sx + reach} ${sy + sag}, ${tx - reach} ${ty + sag}, ${tx} ${ty}`
  return { path, midX: (sx + tx) / 2, sagY: (sy + ty) / 2 + sag * 0.75 }
}
