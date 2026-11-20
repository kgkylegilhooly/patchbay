import type { CanvasStore } from '../../shared/contract'
import { agentOf, type AgentStatus } from '../../shared/model'
import type { AgentStops } from './agentStops'
import { createCodexStops, type CodexStops } from './codexStops'

/** Codex limit, failure and interrupt states, as Claude's. One call from src/main/index.ts. See ./codexStops.ts. */
export function setupCodexStops(d: {
  store: CanvasStore
  tracker: { get(id: string): AgentStatus }
  runner: { handleHook(id: string, payload: Record<string, unknown>): Promise<unknown> }
  stops: Pick<AgentStops, 'noteHook'>
  log?: (line: string) => void
}): CodexStops {
  return createCodexStops({
    nodes: () =>
      d.store.get().nodes.flatMap((n) => (n.kind === 'claude' && agentOf(n) === 'codex' && n.transcriptPath ? [{ id: n.id, transcriptPath: n.transcriptPath, sessionId: n.sessionId }] : [])),
    status: (id) => d.tracker.get(id),
    apply: async (id, payload, limits) => {
      await d.runner.handleHook(id, payload)
      d.stops.noteHook(id, payload, limits)
    },
    log: d.log
  })
}
