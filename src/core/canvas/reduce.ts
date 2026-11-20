import { DISARMED, isProjectArchived, isProjectOpen, type CanvasDoc, type CanvasNode, type CanvasOp, type ClosedSession, type LayoutRestore, type Project, type TriggerNode, type TriggerState } from '../../shared/model'
import { canonicalSpec } from '../trigger/arming'
import { sanitizeBoard } from '../../shared/board'
import { arrangeNodes } from './arrange'
import { archived, archiveRefusal, moveProjectBefore, nearestUnarchived, orderProjects, removeRefusal, unarchived } from './projectOps'

const PADDING = 24
const HEADER = 40
const CLOSED_LIMIT = 200
const MOVE_LIMIT = 10_000_000

type ById = Map<string, CanvasNode>

function byId(nodes: CanvasNode[]): ById {
  return new Map(nodes.map((n) => [n.id, n]))
}

/** Parent chain from nearest to furthest. Stops at a missing parent or a cycle in loaded data. */
function ancestors(nodes: ById, node: CanvasNode): CanvasNode[] {
  const chain: CanvasNode[] = []
  const seen = new Set([node.id])
  let parentId = node.parentId
  while (parentId) {
    const parent = nodes.get(parentId)
    if (!parent || seen.has(parent.id)) break
    chain.push(parent)
    seen.add(parent.id)
    parentId = parent.parentId
  }
  return chain
}

function absolute(nodes: ById, node: CanvasNode): { x: number; y: number } {
  return ancestors(nodes, node).reduce((p, a) => ({ x: p.x + a.x, y: p.y + a.y }), { x: node.x, y: node.y })
}

/** The offset that converts absolute coordinates into a child position for this parent. */
function parentOrigin(nodes: ById, parentId: string | null): { x: number; y: number } {
  const parent = parentId ? nodes.get(parentId) : undefined
  return parent ? absolute(nodes, parent) : { x: 0, y: 0 }
}

/** Keeps the array when it is already in order, so unchanged docs stay cheap to compare. */
function parentsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const map = byId(nodes)
  const placed = new Set<string>()
  const out: CanvasNode[] = []
  const place = (n: CanvasNode): void => {
    if (placed.has(n.id)) return
    placed.add(n.id)
    const parent = n.parentId ? map.get(n.parentId) : undefined
    if (parent) place(parent)
    out.push(n)
  }
  nodes.forEach(place)
  return out.every((n, i) => n === nodes[i]) ? nodes : out
}

/**
 * Fits a group to its children, then its parent group, and so on outward.
 *
 * The right and bottom edges follow the children. The origin moves only when a child would sit
 * past the left edge or under the header, so a group doesn't shift while a child moves around
 * inside it. Children keep their absolute positions. An empty group keeps its size.
 */
function fitOutward(nodes: CanvasNode[], startId: string | null): CanvasNode[] {
  const seen = new Set<string>()
  let id = startId
  let current = nodes
  while (id && !seen.has(id)) {
    seen.add(id)
    const group = current.find((n) => n.id === id)
    if (!group || group.kind !== 'group') break
    const groupId: string = group.id
    const children = current.filter((n) => n.parentId === groupId)
    if (children.length === 0) break

    const minX = Math.min(...children.map((c) => c.x))
    const minY = Math.min(...children.map((c) => c.y))
    const shiftX = minX < PADDING ? PADDING - minX : 0
    const shiftY = minY < HEADER ? HEADER + PADDING - minY : 0
    const width = Math.max(...children.map((c) => c.x + c.width)) + shiftX + PADDING
    const height = Math.max(...children.map((c) => c.y + c.height)) + shiftY + PADDING

    current = current.map((n) => {
      if (n.id === groupId) return { ...n, x: n.x - shiftX, y: n.y - shiftY, width, height }
      if (n.parentId === groupId && (shiftX !== 0 || shiftY !== 0)) return { ...n, x: n.x + shiftX, y: n.y + shiftY }
      return n
    })
    id = group.parentId
  }
  return current
}

function fitAll(nodes: CanvasNode[], ids: Iterable<string | null>): CanvasNode[] {
  let current = nodes
  for (const id of new Set(ids)) current = fitOutward(current, id)
  return current
}

/** A new trigger always starts disarmed with no history, whatever it arrived claiming. */
function freshTrigger(node: CanvasNode): CanvasNode {
  return node.kind === 'trigger' ? { ...node, ...DISARMED, runs: [] } : node
}

function addNode(doc: CanvasDoc, input: CanvasNode): CanvasDoc {
  if (doc.nodes.some((n) => n.id === input.id)) return doc
  const node = freshTrigger(input)
  const parent = doc.nodes.find((n) => n.id === node.parentId)
  const placed = parent?.kind === 'group' ? node : { ...node, parentId: null }
  // An agent's node joins the agent's project, even when the person is looking at another one.
  const opener = doc.nodes.find((n) => n.id === node.openedBy)
  const projectId = (placed.parentId ? parent?.projectId : undefined) ?? opener?.projectId ?? node.projectId ?? doc.activeProjectId
  const added = projectId ? { ...placed, projectId } : placed
  return { ...doc, nodes: fitOutward([...doc.nodes, added], added.parentId) }
}

/** An ordinary patch can't arm a trigger or rewrite its runs, and any change to what it would send disarms it. */
function patchTrigger(node: TriggerNode, patch: Record<string, unknown>): TriggerNode {
  const { armedSpec: _armedSpec, armedAt: _armedAt, nextAt: _nextAt, runs: _runs, ...editable } = patch
  const patched = { ...node, ...editable } as TriggerNode
  return canonicalSpec(patched) === canonicalSpec(node) ? patched : { ...patched, ...DISARMED }
}

function setTriggerState(doc: CanvasDoc, id: string, state: Partial<TriggerState>): CanvasDoc {
  const { armedSpec, armedAt, nextAt, runs } = state
  const only = { ...(armedSpec !== undefined && { armedSpec }), ...(armedAt !== undefined && { armedAt }), ...(nextAt !== undefined && { nextAt }), ...(runs && { runs }) }
  if (!doc.nodes.some((n) => n.id === id && n.kind === 'trigger')) return doc
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? ({ ...n, ...only } as CanvasNode) : n)) }
}

function patchNode(doc: CanvasDoc, id: string, patch: Partial<CanvasNode>): CanvasDoc {
  const node = doc.nodes.find((n) => n.id === id)
  if (!node) return doc
  const { id: _id, kind: _kind, parentId: _parentId, ...allowed } = patch
  const patched = node.kind === 'trigger' ? patchTrigger(node, allowed) : ({ ...node, ...allowed } as CanvasNode)
  const nodes = doc.nodes.map((n) => (n.id === id ? patched : n))
  const moved = patched.x !== node.x || patched.y !== node.y || patched.width !== node.width || patched.height !== node.height
  return { ...doc, nodes: moved ? fitOutward(nodes, node.parentId) : nodes }
}

function closedEntries(doc: CanvasDoc, removed: CanvasNode[], at: number): ClosedSession[] {
  const taken = new Set(doc.closed.map((c) => c.id))
  const entries: ClosedSession[] = []
  for (const n of removed) {
    if (n.kind !== 'claude' || !n.sessionId) continue
    let id = `closed-${n.id}-${at}`
    for (let i = 1; taken.has(id); i++) id = `closed-${n.id}-${at}-${i}`
    taken.add(id)
    entries.push({
      id,
      title: n.title,
      cwd: n.cwd,
      sessionId: n.sessionId,
      transcriptPath: n.transcriptPath,
      closedAt: at,
      ...(n.projectId ? { projectId: n.projectId } : {}),
      ...(n.agent ? { agent: n.agent } : {})
    })
  }
  return entries
}

function removeNodes(doc: CanvasDoc, ids: string[], at: number): CanvasDoc {
  const removing = new Set(ids)
  const removed = doc.nodes.filter((n) => removing.has(n.id))
  if (removed.length === 0) return doc

  const before = byId(doc.nodes)
  const refit = new Set<string | null>(removed.map((n) => n.parentId))
  const nodes: CanvasNode[] = doc.nodes
    .filter((n) => !removing.has(n.id))
    .map((n) => {
      let next = n
      if (n.parentId && removing.has(n.parentId)) {
        // Promote to the nearest group that is staying.
        const parentId = ancestors(before, n).find((a) => !removing.has(a.id))?.id ?? null
        const abs = absolute(before, n)
        const origin = parentOrigin(before, parentId)
        next = { ...next, parentId, x: abs.x - origin.x, y: abs.y - origin.y }
        refit.add(parentId)
      }
      if (next.openedBy && removing.has(next.openedBy)) next = { ...next, openedBy: null }
      if (next.kind === 'claude' && next.after.some((a) => removing.has(a))) {
        next = { ...next, after: next.after.filter((a) => !removing.has(a)) }
      }
      if (next.kind === 'trigger' && next.targetId && removing.has(next.targetId)) {
        next = { ...next, ...DISARMED, targetId: null }
      }
      // The node an event trigger watches went: it can't fire as agreed, so it stops.
      if (next.kind === 'trigger' && (next.schedule.type === 'agent' || next.schedule.type === 'run') && removing.has(next.schedule.nodeId)) {
        next = { ...next, ...DISARMED }
      }
      return next
    })

  const entries = closedEntries(doc, removed, at)
  const closed = entries.length
    ? [...doc.closed, ...entries].sort((a, b) => a.closedAt - b.closedAt).slice(-CLOSED_LIMIT)
    : doc.closed
  return {
    ...doc,
    nodes: fitAll(nodes, [...refit].filter((id) => id === null || !removing.has(id))),
    edges: doc.edges.filter((e) => !removing.has(e.from) && !removing.has(e.to)),
    closed
  }
}

function setParent(doc: CanvasDoc, ids: string[], parentId: string | null): CanvasDoc {
  const map = byId(doc.nodes)
  if (parentId !== null) {
    const parent = map.get(parentId)
    if (!parent || parent.kind !== 'group') return doc
    const blocked = new Set([parentId, ...ancestors(map, parent).map((a) => a.id)])
    if (ids.some((id) => blocked.has(id))) return doc
    if (ids.some((id) => map.has(id) && map.get(id)!.projectId !== parent.projectId)) return doc
  }
  const moving = new Set(ids.filter((id) => map.has(id) && map.get(id)!.parentId !== parentId))
  if (moving.size === 0) return doc

  const origin = parentOrigin(map, parentId)
  const refit = new Set<string | null>([parentId])
  const nodes = doc.nodes.map((n) => {
    if (!moving.has(n.id)) return n
    refit.add(n.parentId)
    const abs = absolute(map, n)
    return { ...n, parentId, x: abs.x - origin.x, y: abs.y - origin.y }
  })
  return { ...doc, nodes: fitAll(nodes, refit) }
}

function arrange(doc: CanvasDoc, ids: string[], layout: 'grid' | 'row' | 'column', gap?: number): CanvasDoc {
  const map = byId(doc.nodes)
  const named = new Set(ids)
  // A child moves with its group, so a group named alongside its child wins.
  const targets = [...named]
    .map((id) => map.get(id))
    .filter((n): n is CanvasNode => !!n && !ancestors(map, n).some((a) => named.has(a.id)))
  if (targets.length === 0) return doc

  const placed = arrangeNodes(targets.map((n) => ({ ...n, ...absolute(map, n) })), layout, gap)
  const positions = new Map(placed.map((p) => [p.id, p]))
  const nodes = doc.nodes.map((n) => {
    const p = positions.get(n.id)
    if (!p) return n
    const origin = parentOrigin(map, n.parentId)
    return { ...n, x: p.x - origin.x, y: p.y - origin.y }
  })
  return { ...doc, nodes: fitAll(nodes, targets.map((n) => n.parentId)) }
}

/** Positions are relative to each node's parent. A move that isn't a finite number is left out. */
function moveNodes(doc: CanvasDoc, moves: { id: string; x: number; y: number }[]): CanvasDoc {
  // Far enough out to hold any real canvas, near enough that a stray number can't lose a node.
  const clamp = (v: number): number => Math.max(-MOVE_LIMIT, Math.min(MOVE_LIMIT, v))
  const to = new Map(
    (Array.isArray(moves) ? moves : []).filter((m) => Number.isFinite(m?.x) && Number.isFinite(m?.y)).map((m) => [m.id, { x: clamp(m.x), y: clamp(m.y) }])
  )
  const parents = new Set<string | null>()
  let changed = false
  const nodes = doc.nodes.map((n) => {
    const m = to.get(n.id)
    if (!m || (m.x === n.x && m.y === n.y)) return n
    changed = true
    parents.add(n.parentId)
    return { ...n, x: m.x, y: m.y }
  })
  return changed ? { ...doc, nodes: fitAll(nodes, parents) } : doc
}

/** Keeps the current view with the project being left, and brings back the view of the one being shown. */
function showProject(doc: CanvasDoc, id: string): CanvasDoc {
  const target = doc.projects.find((p) => p.id === id)
  // An archived project comes back only through unarchiveProject, never by being shown.
  if (!target || id === doc.activeProjectId || isProjectArchived(target)) return doc
  const projects = doc.projects.map((p) => {
    if (p.id === doc.activeProjectId) return { ...p, viewport: doc.viewport }
    if (p.id !== id || isProjectOpen(p)) return p
    const { closedAt: _closedAt, ...open } = p
    return open
  })
  return { ...doc, projects, activeProjectId: id, viewport: target.viewport }
}

/** The tab that takes this one's place on screen, as closing a browser tab does: the next open one, or else the last before it. */
function openNeighbor(doc: CanvasDoc, id: string): Project | undefined {
  const index = doc.projects.findIndex((p) => p.id === id)
  const open = (p: Project): boolean => isProjectOpen(p) && p.id !== id
  return doc.projects.slice(index + 1).find(open) ?? doc.projects.slice(0, index).reverse().find(open)
}

function closeProject(doc: CanvasDoc, id: string, at: number): CanvasDoc {
  const target = doc.projects.find((p) => p.id === id)
  if (!target || !isProjectOpen(target)) return doc
  const neighbor = openNeighbor(doc, id)
  if (!neighbor) return doc
  const shown = id === doc.activeProjectId ? showProject(doc, neighbor.id) : doc
  return { ...shown, projects: shown.projects.map((p) => (p.id === id ? { ...p, closedAt: at } : p)) }
}

function removeProject(doc: CanvasDoc, id: string, at: number): CanvasDoc {
  if (removeRefusal(doc, id)) return doc
  // With every other project closed, one of them has to come back, since something must stay on screen.
  const neighbor = openNeighbor(doc, id) ?? nearestUnarchived(doc, id)
  const shown = id === doc.activeProjectId && neighbor ? showProject(doc, neighbor.id) : doc
  const emptied = removeNodes(shown, shown.nodes.filter((n) => n.projectId === id).map((n) => n.id), at)
  return { ...emptied, projects: emptied.projects.filter((p) => p.id !== id) }
}

/** Main has stopped its sessions by now. Its nodes, notes, board and layout all stay. */
function archiveProject(doc: CanvasDoc, id: string, at: number): CanvasDoc {
  if (archiveRefusal(doc, id)) return doc
  const neighbor = openNeighbor(doc, id) ?? nearestUnarchived(doc, id)
  const shown = id === doc.activeProjectId && neighbor ? showProject(doc, neighbor.id) : doc
  if (shown.activeProjectId === id) return doc
  return { ...shown, projects: shown.projects.map((p) => (p.id === id ? archived(p, at) : p)) }
}

function unarchiveProject(doc: CanvasDoc, id: string, open: boolean): CanvasDoc {
  const target = doc.projects.find((p) => p.id === id)
  if (!target || !isProjectArchived(target)) return doc
  const back = { ...doc, projects: doc.projects.map((p) => (p.id === id ? unarchived(p) : p)) }
  return open ? showProject(back, id) : back
}

// A file icon is layout too: it only points at a file.
const isLayoutOnly = (n: CanvasNode): boolean => n.kind === 'sticky' || n.kind === 'whiteboard' || n.kind === 'group' || n.kind === 'reader' || n.kind === 'file'

/**
 * Removing comes before the patches, so what they say wins over any refitting the removal did. A node whose old
 * group has since gone stays where it is, and a session is never added or removed here.
 */
function restoreLayout(doc: CanvasDoc, r: LayoutRestore): CanvasDoc {
  const known = new Set(doc.nodes.map((n) => n.id))
  const added = r.add.filter((n) => isLayoutOnly(n) && !known.has(n.id))
  const withAdded: CanvasDoc = added.length ? { ...doc, nodes: [...doc.nodes, ...added] } : doc
  const removable = new Set(withAdded.nodes.filter(isLayoutOnly).map((n) => n.id))
  const removed = removeNodes(withAdded, r.remove.filter((id) => removable.has(id)), 0)
  const here = byId(removed.nodes)
  const patches = new Map(
    r.patches
      .filter((p) => here.has(p.id) && (p.parentId === null || here.get(p.parentId)?.kind === 'group'))
      .map((p) => [p.id, p])
  )
  const nodes = removed.nodes.map((n) => {
    const p = patches.get(n.id)
    return p ? ({ ...n, x: p.x, y: p.y, width: p.width, height: p.height, parentId: p.parentId, title: p.title } as CanvasNode) : n
  })
  const edges = [
    ...removed.edges,
    ...r.edges.filter((e) => here.has(e.from) && here.has(e.to) && !removed.edges.some((have) => have.id === e.id))
  ]
  const projects = r.projectOrder ? orderProjects(removed.projects, r.projectOrder) : removed.projects
  return { ...removed, nodes, edges, projects }
}

function apply(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  switch (op.op) {
    case 'closeProject':
      return closeProject(doc, op.id, op.at)
    case 'restoreLayout':
      return restoreLayout(doc, op)
    case 'addProject': {
      if (doc.projects.some((p) => p.id === op.project.id)) return doc
      // A new project starts with no tasks. Task records only ever come from the task service, through setTasks.
      const { tasks: _tasks, ...project } = op.project
      return showProject({ ...doc, projects: [...doc.projects, project] }, project.id)
    }
    case 'patchProject': {
      if (!doc.projects.some((p) => p.id === op.id)) return doc
      // Only what the op is for. A patch carrying anything else, such as tasks, would let the page forge outcomes.
      const patch: Partial<Pick<Project, 'name' | 'folder'>> = {}
      if (typeof op.patch.name === 'string') patch.name = op.patch.name
      if (typeof op.patch.folder === 'string') patch.folder = op.patch.folder
      return { ...doc, projects: doc.projects.map((p) => (p.id === op.id ? { ...p, ...patch } : p)) }
    }
    case 'setTasks':
      return { ...doc, projects: doc.projects.map((p) => p.id === op.projectId ? { ...p, tasks: op.tasks } : p) }
    case 'setBoard': {
      const board = sanitizeBoard(op.board)
      if (!board || !doc.projects.some((p) => p.id === op.projectId)) return doc
      return { ...doc, projects: doc.projects.map((p) => (p.id === op.projectId ? { ...p, board } : p)) }
    }
    case 'switchProject':
      return showProject(doc, op.id)
    case 'removeProject':
      return removeProject(doc, op.id, op.at)
    case 'moveProject': {
      const projects = moveProjectBefore(doc.projects, op.id, op.before)
      return projects === doc.projects ? doc : { ...doc, projects }
    }
    case 'archiveProject':
      return archiveProject(doc, op.id, op.at)
    case 'unarchiveProject':
      return unarchiveProject(doc, op.id, op.open)
    case 'addNode':
      return addNode(doc, op.node)
    case 'patchNode':
      return patchNode(doc, op.id, op.patch)
    case 'setTriggerState':
      return setTriggerState(doc, op.id, op.state)
    case 'removeNodes':
      return removeNodes(doc, op.ids, op.at)
    case 'removeClosed':
      return doc.closed.some((c) => c.id === op.id) ? { ...doc, closed: doc.closed.filter((c) => c.id !== op.id) } : doc
    case 'addEdge': {
      const { edge } = op
      const nodeIds = new Set(doc.nodes.map((n) => n.id))
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return doc
      const duplicate = doc.edges.some(
        (e) => e.id === edge.id || (e.from === edge.from && e.to === edge.to && e.kind === edge.kind)
      )
      return duplicate ? doc : { ...doc, edges: [...doc.edges, edge] }
    }
    case 'removeEdge':
      return doc.edges.some((e) => e.id === op.id) ? { ...doc, edges: doc.edges.filter((e) => e.id !== op.id) } : doc
    case 'setParent':
      return setParent(doc, op.ids, op.parentId)
    case 'setViewport':
      return { ...doc, viewport: op.viewport }
    case 'arrange':
      return arrange(doc, op.ids, op.layout, op.gap)
    case 'moveNodes':
      return moveNodes(doc, op.moves)
  }
}

/** Pure. A refused op returns the same doc object. Nodes are always parents-first in the result. */
export function reduce(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  const next = apply(doc, op)
  if (next === doc) return doc
  const nodes = parentsFirst(next.nodes)
  return nodes === next.nodes ? next : { ...next, nodes }
}
