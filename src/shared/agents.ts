import { AGENT_NAMES, type AgentKind } from './model'
import type { Settings } from './settings'

/**
 * Which agents Patchbay may start, from Settings > Agents. Every place that starts an agent asks here, in the main
 * process as the source of truth and in the canvas to hide what it can't start. Sessions already running are never
 * touched: an agent turned off only stops new ones, restarts and resumes.
 */

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex']

/** What the settings allow now: the agents Patchbay may start, and the one it uses when none is named. */
export interface AgentChoice {
  /** Never empty. */
  enabled: AgentKind[]
  /** Always one of `enabled`. */
  default: AgentKind
}

export const isAgentKind = (v: unknown): v is AgentKind => v === 'claude' || v === 'codex'

/** The agents settings.agentsOff names. A file naming every agent is read as naming none, since one must stay on. */
function agentsOff(s: Settings): AgentKind[] {
  const named = (s.agentsOff ?? '').split(/[\s,]+/).filter(isAgentKind)
  return AGENT_KINDS.every((k) => named.includes(k)) ? [] : named
}

export function agentChoice(s: Settings): AgentChoice {
  const off = agentsOff(s)
  const enabled = AGENT_KINDS.filter((k) => !off.includes(k))
  const wanted: AgentKind = s.defaultAgent === 'codex' ? 'codex' : 'claude'
  return { enabled, default: enabled.includes(wanted) ? wanted : enabled[0] }
}

/** The agent used when none is named: the chosen default, or the one still on when that's turned off. */
export const defaultAgentOf = (s: Settings): AgentKind => agentChoice(s).default

/** "Claude Code", or "Claude Code and Codex". */
export const agentNames = (kinds: readonly AgentKind[]): string => kinds.map((k) => AGENT_NAMES[k]).join(' and ')

/** Why an agent can't be started, naming the setting and what's still on. Null when it may start. */
export function agentOffReason(kind: AgentKind, choice: AgentChoice): string | null {
  if (choice.enabled.includes(kind)) return null
  return `${AGENT_NAMES[kind]} is turned off in Settings > Agents, so Patchbay won't start it. Patchbay may use ${agentNames(choice.enabled)}.`
}

/**
 * The settings with one agent turned on or off. Null when that would turn off the last one: at least one stays on.
 * With every agent on, the field is left out, so the file reads as it did before the setting existed.
 */
export function withAgent(s: Settings, kind: AgentKind, on: boolean): Settings | null {
  const off = new Set(agentsOff(s))
  if (on) off.delete(kind)
  else off.add(kind)
  if (AGENT_KINDS.every((k) => off.has(k))) return null
  const next: Settings = { ...s, agentsOff: AGENT_KINDS.filter((k) => off.has(k)).join(' ') }
  if (!next.agentsOff) delete next.agentsOff
  return next
}

/** What Settings says under Default agent when the chosen one is turned off. Null when it's on. */
export function defaultAgentNote(s: Settings): string | null {
  const wanted: AgentKind = s.defaultAgent === 'codex' ? 'codex' : 'claude'
  const { default: used } = agentChoice(s)
  return used === wanted ? null : `${AGENT_NAMES[wanted]} is turned off, so ${AGENT_NAMES[used]} is the default until ${AGENT_NAMES[wanted]} is on again.`
}

/** Commands that open one kind of agent, by id, as menus, the palette and the dock name them. */
const AGENT_COMMANDS: Record<string, AgentKind> = { 'new-claude': 'claude', 'new-codex': 'codex' }

/** Whether a command, menu item or button can be offered: false only for one that opens an agent that's off. */
export function commandAllowed(id: string, choice: AgentChoice): boolean {
  const kind = AGENT_COMMANDS[id]
  return !kind || choice.enabled.includes(kind)
}

/**
 * The agent a recipe's or another plan's agent starts as: its own when that's on, or `instead` when the person chose it
 * and it's on. Null when it can't start.
 */
export function agentToStart(kind: AgentKind, choice: AgentChoice, instead?: AgentKind): AgentKind | null {
  if (choice.enabled.includes(kind)) return kind
  return instead && choice.enabled.includes(instead) ? instead : null
}
