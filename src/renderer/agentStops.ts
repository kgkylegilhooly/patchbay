import { create } from 'zustand'
import type { AgentStop, AgentStopBridge } from '../shared/agentStop'

declare global {
  interface Window {
    patchbayStops?: AgentStopBridge
  }
}

/** Why agents stopped on StopFailure, such as a usage limit, as main last said. */
export const useAgentStops = create<{ stops: Record<string, AgentStop> }>(() => ({ stops: {} }))

/** Loads what's known now and follows changes. Call once. Does nothing where there's no bridge, as in tests. */
export function connectAgentStops(): void {
  const bridge = window.patchbayStops
  if (!bridge) return
  bridge.onChange((id, stop) =>
    useAgentStops.setState((s) => {
      const stops = { ...s.stops }
      if (stop) stops[id] = stop
      else delete stops[id]
      return { stops }
    })
  )
  void bridge.all().then((all) => useAgentStops.setState((s) => ({ stops: { ...all, ...s.stops } })))
}

/** The node's stop, if its status is still the `unknown` StopFailure left. */
export function useAgentStop(id: string | undefined): AgentStop | undefined {
  return useAgentStops((s) => (id ? s.stops[id] : undefined))
}
