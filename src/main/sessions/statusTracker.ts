import { nextStatus, type StatusEvent } from '../../core/status/machine'
import type { AgentStatus } from '../../shared/model'

export interface StatusTracker {
  /** `unknown` for a node nothing has been heard from. */
  get(id: string): AgentStatus
  all(): Record<string, AgentStatus>
  apply(id: string, ev: StatusEvent): void
  /** Sets what's known about a session this launch didn't see happen. Nobody is notified about the past. */
  seed(id: string, status: AgentStatus, turns?: number): void
  turnsCompleted(id: string): number
  onChange(cb: (id: string, status: AgentStatus) => void): void
}

/** Statuses a turn is in progress in, so reaching idle from one means that turn finished. */
const IN_TURN = new Set<AgentStatus>(['working', 'needs-you', 'unknown'])

export function createStatusTracker({
  notify
}: {
  notify: (id: string, status: AgentStatus) => void
}): StatusTracker {
  const statuses = new Map<string, AgentStatus>()
  const turns = new Map<string, number>()
  const listeners: Array<(id: string, status: AgentStatus) => void> = []

  return {
    get: (id) => statuses.get(id) ?? 'unknown',
    all: () => Object.fromEntries(statuses),
    turnsCompleted: (id) => turns.get(id) ?? 0,
    onChange(cb) {
      listeners.push(cb)
    },
    seed(id, status, turnsDone = 0) {
      const cur = statuses.get(id)
      statuses.set(id, status)
      if (turnsDone) turns.set(id, (turns.get(id) ?? 0) + turnsDone)
      if (status !== cur || turnsDone) for (const cb of listeners) cb(id, status)
    },
    apply(id, ev) {
      const cur = statuses.get(id)
      const next = nextStatus(cur ?? 'unknown', ev)
      if (next === cur) return
      statuses.set(id, next)
      const finishedTurn = next === 'idle' && cur !== undefined && IN_TURN.has(cur)
      if (finishedTurn) turns.set(id, (turns.get(id) ?? 0) + 1)
      for (const cb of listeners) cb(id, next)
      if (next === 'needs-you' || finishedTurn) notify(id, next)
    }
  }
}
