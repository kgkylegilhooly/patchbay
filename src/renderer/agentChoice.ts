import { create } from 'zustand'
import { agentChoice, commandAllowed, type AgentChoice } from '../shared/agents'
import type { Settings } from '../shared/settings'

/**
 * Settings > Agents in the window, so places that start an agent can leave out one that's turned off. The main process
 * refuses it anyway; this only keeps it from being offered. Every agent is on until the settings are read.
 */
export const useAgentChoice = create<AgentChoice>(() => agentChoice({}))

export const agentChoiceNow = (): AgentChoice => useAgentChoice.getState()

/** Called with settings as they're read or saved. */
export const noteAgentSettings = (s: Settings): void => useAgentChoice.setState(agentChoice(s), true)

/** Reads them once at start-up. Given the reader, so this module loads where there's no window, as in tests. */
export function loadAgentChoice(read: () => Promise<Settings>): void {
  void read()
    .then(noteAgentSettings)
    .catch(() => undefined)
}

/** For a command, menu item or button: false only when it opens an agent that's turned off. */
export const offerCommand = (id: string): boolean => commandAllowed(id, agentChoiceNow())
