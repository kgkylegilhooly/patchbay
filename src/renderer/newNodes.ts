import { BLANK } from '../shared/browserPolicy'
import { absoluteRect, placeInGroup, placeInProject, placeNear, type Rect } from '../core/canvas/place'
import { DISARMED, type AgentKind, type BrowserNode, type CanvasDoc, type CanvasNode, type ClaudeNode, type GroupNode, type RunNode, type StickyNode, type TerminalNode, type TriggerNode, type WhiteboardNode } from '../shared/model'

export const SIZES = {
  trigger: { width: 360, height: 400 },
  terminal: { width: 560, height: 340 },
  run: { width: 560, height: 300 },
  claude: { width: 620, height: 420 },
  sticky: { width: 280, height: 220 },
  whiteboard: { width: 640, height: 460 },
  group: { width: 640, height: 400 },
  browser: { width: 760, height: 560 }
}

export function absolutePosition(doc: CanvasDoc, node: CanvasNode): { x: number; y: number } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  let { x, y } = node
  const seen = new Set([node.id])
  let parent = node.parentId ? byId.get(node.parentId) : undefined
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id)
    x += parent.x
    y += parent.y
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return { x, y }
}

export interface Place {
  /** Where the top-left corner should go, such as where the person clicked. Moved only as far as it takes to keep clear of other nodes. */
  at?: { x: number; y: number }
  /** The node it belongs next to, such as the selected one, when no spot was given. */
  beside?: CanvasNode
  /** The canvas on screen, in canvas coordinates. Without a spot or a node, the new one goes in its middle. */
  view?: Rect | null
  /** Group to open inside, if one is selected. */
  group: GroupNode | null
  doc: CanvasDoc
}

/** Where a new node of this size goes: inside the group in its next free cell, or the nearest free spot on the canvas. */
export function placed(p: Place, size: { width: number; height: number }): Pick<CanvasNode, 'x' | 'y' | 'parentId'> & typeof size {
  if (p.group) return { ...size, ...placeInGroup(p.doc, p.group.id, size), parentId: p.group.id }
  const projectId = p.doc.activeProjectId
  const view = p.view ?? null
  const spot = p.at
    ? placeNear(p.doc, { at: p.at, size, projectId, view })
    : p.beside
      ? placeNear(p.doc, { beside: absoluteRect(p.doc, p.beside), size, projectId, view })
      : view
        ? placeNear(p.doc, { at: { x: view.x + (view.width - size.width) / 2, y: view.y + (view.height - size.height) / 2 }, size, projectId, view })
        : placeInProject(p.doc, projectId, size)
  return { ...size, ...spot, parentId: null }
}

export function newTerminal(p: Place, id: string, fields: { cwd: string; command?: string; profile?: { id: string; name: string } }): TerminalNode {
  const node: TerminalNode = {
    ...placed(p, SIZES.terminal),
    id,
    kind: 'terminal',
    title: fields.command ? fields.command.split(/\s+/)[0] : (fields.profile?.name ?? 'Terminal'),
    cwd: fields.cwd
  }
  if (fields.command) node.command = fields.command
  if (fields.profile) node.profile = fields.profile.id
  return node
}

/** A terminal that runs ssh to a host. It starts from the person's home folder, as ssh would in a shell. */
export function newSsh(p: Place, id: string, fields: { host: string; home: string }): TerminalNode {
  return { ...placed(p, SIZES.terminal), id, kind: 'terminal', title: fields.host, cwd: fields.home, sshHost: fields.host }
}

export function newRun(p: Place, id: string, fields: { cwd: string; command: string }): RunNode {
  return { ...placed(p, SIZES.run), id, kind: 'run', title: fields.command.slice(0, 40), cwd: fields.cwd, command: fields.command }
}

/**
 * A run node for one launch.json configuration. Its command is only a placeholder: main reads launch.json again and
 * sets the real one on each Run.
 */
export function newLaunchRun(p: Place, id: string, launch: { folder: string; name: string; approved?: string }): RunNode {
  return { ...placed(p, SIZES.run), id, kind: 'run', title: launch.name, cwd: launch.folder, command: `launch.json: ${launch.name}`, launch }
}

export function newTrigger(p: Place, id: string, fields: Pick<TriggerNode, 'schedule' | 'prompt' | 'targetId'>): TriggerNode {
  return { ...placed(p, SIZES.trigger), id, kind: 'trigger', title: 'Trigger', ...fields, ...DISARMED, runs: [] }
}

export function newClaude(p: Place, id: string, fields: { cwd: string; prompt?: string; agent?: AgentKind }): ClaudeNode {
  const node: ClaudeNode = {
    ...placed(p, SIZES.claude),
    id,
    kind: 'claude',
    ...(fields.agent === 'codex' ? { agent: 'codex' as const } : {}),
    title: fields.agent === 'codex' ? 'Codex' : 'Claude',
    cwd: fields.cwd,
    sessionId: null,
    transcriptPath: null,
    after: []
  }
  if (fields.prompt) node.prompt = fields.prompt
  return node
}

export function newBrowser(p: Place, id: string, url: string = BLANK): BrowserNode {
  return { ...placed(p, SIZES.browser), id, kind: 'browser', title: 'Browser', url }
}

export function newSticky(p: Place, id: string): StickyNode {
  return { ...placed(p, SIZES.sticky), id, kind: 'sticky', title: 'Note', text: '' }
}

export function newWhiteboard(p: Place, id: string): WhiteboardNode {
  return { ...placed(p, SIZES.whiteboard), id, kind: 'whiteboard', title: 'Whiteboard', shapes: [] }
}

/** The frame for a new group around these nodes, or an empty one at the given spot. */
export function newGroup(doc: CanvasDoc, at: { x: number; y: number }, id: string, members: CanvasNode[]): GroupNode {
  const base = { id, kind: 'group' as const, title: 'Group', parentId: null, worktree: null }
  if (members.length === 0) return { ...base, ...SIZES.group, x: at.x, y: at.y }
  const boxes = members.map((m) => ({ ...absolutePosition(doc, m), width: m.width, height: m.height }))
  const x = Math.min(...boxes.map((b) => b.x)) - 24
  const y = Math.min(...boxes.map((b) => b.y)) - 64
  return {
    ...base,
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) + 24 - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) + 24 - y
  }
}

/** The selected nodes a new group should take: a child whose group is also selected moves with it. */
export function groupMembers(doc: CanvasDoc, selected: string[]): CanvasNode[] {
  const chosen = new Set(selected)
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  return doc.nodes.filter((n) => {
    if (!chosen.has(n.id)) return false
    const seen = new Set([n.id])
    let parent = n.parentId ? byId.get(n.parentId) : undefined
    while (parent && !seen.has(parent.id)) {
      if (chosen.has(parent.id)) return false
      seen.add(parent.id)
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    return true
  })
}
