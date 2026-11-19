import { agentChoice, agentOffReason, type AgentChoice } from '../shared/agents'
import type { AgentKind } from '../shared/model'
import type { Settings } from '../shared/settings'

/**
 * Settings > Agents for the main process, read at each call so a saved change applies at once. Set once at start-up;
 * until then, and in tests that don't set it, every agent is on.
 */
let read: () => Settings = () => ({})

export function readAgentsFrom(settings: () => Settings): void {
  read = settings
}

export const agentsNow = (): AgentChoice => agentChoice(read())

/** Why this agent may not be started now, naming the setting and the agents still on. Null when it may. */
export const agentOffNow = (kind: AgentKind): string | null => agentOffReason(kind, agentsNow())
