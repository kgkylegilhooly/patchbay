import { nextStatus, type StatusEvent } from '../../core/status/machine'
import type { AgentStatus } from '../../shared/model'

export interface StatusTracker {
  /** `unknown` for a node nothing has been heard from. */
  get(id: string): AgentStatus
  all(): Record<string, AgentStatus>
  apply(id: string, ev: StatusEvent): void
  /**
   * Sets what's known about a session this launch didn't see happen. No desktop notification is shown for it, but
   * `onChange` listeners are told, with `caughtUp` set, since it may be an event they missed.
   */
  seed(id: string, status: AgentStatus, turns?: number): void
  turnsCompleted(id: string): number
  /**
   * When the status last changed. `exact` is false for one seeded from a session this launch didn't watch, which may
   * have been that way for longer.
   */
  since(id: string): StatusSince | undefined
  onChange(cb: StatusListener): void
}

/** `caughtUp` is true for a status seeded after the fact, not seen as it happened. */
export type StatusListener = (id: string, status: AgentStatus, info?: { caughtUp: boolean }) => void

export interface StatusSince {
  at: number
  exact: boolean
}

/** Statuses a turn is in progress in, so reaching idle from one means that turn finished. */
const IN_TURN = new Set<AgentStatus>(['working', 'needs-you', 'unknown'])

export function createStatusTracker({
  notify,
  now = Date.now
}: {
  notify: (id: string, status: AgentStatus) => void
  now?: () => number
}): StatusTracker {
  const statuses = new Map<string, AgentStatus>()
  const changedAt = new Map<string, StatusSince>()
  const turns = new Map<string, number>()
  const listeners: StatusListener[] = []

  return {
    get: (id) => statuses.get(id) ?? 'unknown',
    all: () => Object.fromEntries(statuses),
    turnsCompleted: (id) => turns.get(id) ?? 0,
    since: (id) => changedAt.get(id),
    onChange(cb) {
      listeners.push(cb)
    },
    seed(id, status, turnsDone = 0) {
      const cur = statuses.get(id)
      statuses.set(id, status)
      if (status !== cur) changedAt.set(id, { at: now(), exact: false })
      if (turnsDone) turns.set(id, (turns.get(id) ?? 0) + turnsDone)
      if (status !== cur || turnsDone) for (const cb of listeners) cb(id, status, { caughtUp: true })
    },
    apply(id, ev) {
      const cur = statuses.get(id)
      const next = nextStatus(cur ?? 'unknown', ev)
      if (next === cur) return
      statuses.set(id, next)
      changedAt.set(id, { at: now(), exact: true })
      const finishedTurn = next === 'idle' && cur !== undefined && IN_TURN.has(cur)
      if (finishedTurn) turns.set(id, (turns.get(id) ?? 0) + 1)
      for (const cb of listeners) cb(id, next, { caughtUp: false })
      if (next === 'needs-you' || finishedTurn) notify(id, next)
    }
  }
}
