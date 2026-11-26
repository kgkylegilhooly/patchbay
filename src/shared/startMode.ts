import { agentOf, type ClaudeNode } from './model'

/**
 * F61: how one Claude agent starts, set in the New Claude Code form: its permission mode and model, over the global
 * setting. Only the person sets these (agents opening agents can't), and only these modes: never bypass.
 */

export const START_MODES = ['default', 'plan', 'acceptEdits'] as const
export type StartMode = (typeof START_MODES)[number]

/** In the form and on the window's chip. */
export const START_MODE_LABELS: Record<StartMode, string> = { default: 'Asks first', plan: 'Plans first', acceptEdits: 'Accepts edits' }

/** A mode Patchbay starts an agent with, or undefined for anything else, bypass included. */
export const startModeOf = (v: unknown): StartMode | undefined => (START_MODES as readonly unknown[]).includes(v) ? (v as StartMode) : undefined

/** A model alias or id (opus, sonnet, claude-sonnet-5-5[1m]): one word, never read as an option. Otherwise undefined. */
export function modelNameOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const name = v.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/.test(name) ? name : undefined
}

/** "Plans first · sonnet" on a Claude window started its own way. Null when it follows Settings, or for Codex. */
export function startChipText(node: Pick<ClaudeNode, 'agent' | 'startMode' | 'model'>): string | null {
  if (agentOf(node) !== 'claude') return null
  const mode = startModeOf(node.startMode)
  const parts = [mode ? START_MODE_LABELS[mode] : null, modelNameOf(node.model) ?? null].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
