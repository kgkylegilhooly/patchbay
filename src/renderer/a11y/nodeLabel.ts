import { AGENT_NAMES, type AgentStatus, type CanvasNode } from '../../shared/model'
import { AGENT_LABELS } from '../status/status'

const KIND_NAMES: Record<CanvasNode['kind'], string> = {
  terminal: 'Terminal',
  claude: 'Claude Code',
  run: 'Run command',
  sticky: 'Note',
  whiteboard: 'Whiteboard',
  group: 'Group',
  browser: 'Browser',
  trigger: 'Trigger',
  reader: 'Document',
  file: 'File'
}

/** What kind of window it is, in words: "Codex" for a Codex agent. */
export function kindName(node: CanvasNode): string {
  if (node.kind === 'claude') return AGENT_NAMES[node.agent ?? 'claude']
  return KIND_NAMES[node.kind] ?? 'Window'
}

/**
 * The one name a screen reader gives a window on the canvas: "Fix the login, Claude Code, Needs you". The status is left
 * out when there's none to tell, as for a note, or when Patchbay can't tell yet.
 */
export function nodeAriaLabel(node: CanvasNode, status: AgentStatus | null): string {
  const title = node.title?.trim() || 'Untitled'
  const parts = [title, kindName(node)]
  if (status && status !== 'unknown') parts.push(AGENT_LABELS[status])
  return parts.join(', ')
}

/** What closing a window asks first, if anything: the same question its close button and menu ask. */
export function closeQuestion(status: AgentStatus | null | undefined): string | undefined {
  if (status === 'working') return 'Still working. Close anyway?'
  if (status === 'needs-you') return 'Waiting on you. Close anyway?'
  return undefined
}
