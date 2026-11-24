import type { AgentStatus } from '../../shared/model'

/** What `wait --next` watches: an agent's status changing, and a message one node sends another. */
export type WaitEvent = { type: 'status'; id: string; status: AgentStatus } | { type: 'message'; from: string; to: string }

/** Why `wait --next` returned. */
export interface NextChange {
  node: string
  /** finished: it settled (idle, needs-you, exited); stopped: at a usage limit or on an error; message: it sent you one; closed: it's gone. */
  why: 'finished' | 'stopped' | 'message' | 'closed'
}

const SETTLED = new Set<AgentStatus>(['idle', 'needs-you', 'exited'])

/** A fan-out of WaitEvents, since the status tracker can't take a listener back. */
export function createWaitEvents(): { emit(e: WaitEvent): void; subscribe(cb: (e: WaitEvent) => void): () => void } {
  const listeners = new Set<(e: WaitEvent) => void>()
  return {
    emit(e) {
      for (const cb of [...listeners]) cb(e)
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

/**
 * The first thing that happens after the call among these agents: one settles, stops at a limit, sends the caller a
 * message, or is closed. What they already were when the call came doesn't count, so a lead can wait for the next
 * report from a team where some members sit idle waiting for review. Null at the timeout.
 */
export function nextChange({
  caller,
  ids,
  timeoutMs,
  pollMs,
  subscribe,
  exists,
  stopped
}: {
  caller: string
  ids: string[]
  timeoutMs: number
  pollMs: number
  subscribe: (cb: (e: WaitEvent) => void) => () => void
  exists: (id: string) => boolean
  /** Stopped on StopFailure, as at a usage limit. Learned a moment after the status changes, so it's polled. */
  stopped: (id: string) => boolean
}): Promise<NextChange | null> {
  const watched = new Set(ids)
  const stoppedBefore = new Set(ids.filter(stopped))
  return new Promise((resolve) => {
    let over = false
    const finish = (change: NextChange | null): void => {
      if (over) return
      over = true
      unsubscribe()
      clearInterval(timer)
      clearTimeout(limit)
      resolve(change)
    }
    const unsubscribe = subscribe((e) => {
      if (e.type === 'message') {
        if (e.to === caller && watched.has(e.from)) finish({ node: e.from, why: 'message' })
        return
      }
      if (!watched.has(e.id)) return
      if (SETTLED.has(e.status)) finish({ node: e.id, why: 'finished' })
      // Busy again: a stop it had is over, so a later one counts.
      else stoppedBefore.delete(e.id)
    })
    const timer = setInterval(() => {
      for (const id of ids) {
        if (!exists(id)) return finish({ node: id, why: 'closed' })
        if (stopped(id) && !stoppedBefore.has(id)) return finish({ node: id, why: 'stopped' })
      }
    }, pollMs)
    timer.unref?.()
    const limit = setTimeout(() => finish(null), timeoutMs)
    limit.unref?.()
  })
}
