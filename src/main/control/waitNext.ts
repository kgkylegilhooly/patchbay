import type { AgentStatus } from '../../shared/model'

/** What wakes a `wait --next`: an agent's status changing, and a message one node sends another. */
export type WaitEvent = { type: 'status'; id: string; status: AgentStatus } | { type: 'message'; from: string; to: string }

/** Why `wait --next` returned. */
export interface NextChange {
  node: string
  /** finished: it settled (idle, needs-you, exited); stopped: at a usage limit or on an error; message: it sent you one; closed: it's gone. */
  why: 'finished' | 'stopped' | 'message' | 'closed'
}

const SETTLED = new Set<AgentStatus>(['idle', 'needs-you', 'exited'])
/** Status changes kept for callers to catch up on. A lead's loop reads them within minutes; this is hours of a big team. */
const KEPT_EVENTS = 5000

interface Logged {
  seq: number
  id: string
  status: AgentStatus
}

/**
 * Every agent's status changes, numbered, and each caller's place in them. A `wait --next` returns the first change
 * past the caller's place for the agents it names, and moves that place on, so a turn that ended while the caller was
 * busy between two waits is the next one's answer, and no turn is handed out twice. A caller's place for an agent
 * starts where its first `wait --next` did: what agents already were before then doesn't count.
 */
export function createWaitLog(keep = KEPT_EVENTS) {
  let seq = 0
  const events: Logged[] = []
  const listeners = new Set<(e: WaitEvent) => void>()
  /** caller -> where its first --next started, and its place per agent. */
  const places = new Map<string, { start: number; at: Map<string, number> }>()
  return {
    /** Wakes the waits on any event; a status change is logged first. */
    emit(e: WaitEvent): void {
      if (e.type === 'status') {
        events.push({ seq: ++seq, id: e.id, status: e.status })
        if (events.length > keep) events.splice(0, events.length - keep)
      }
      for (const cb of [...listeners]) cb(e)
    },
    subscribe(cb: (e: WaitEvent) => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    /** Where this caller stands for each agent, starting it here on its first call. */
    placeOf(caller: string): { of(id: string): number; set(ids: string[], to: number): void } {
      let place = places.get(caller)
      if (!place) places.set(caller, (place = { start: seq, at: new Map() }))
      const p = place
      return { of: (id) => p.at.get(id) ?? p.start, set: (ids, to) => ids.forEach((id) => p.at.set(id, to)) }
    },
    /** The first change past `after(id)` among these agents that counts, or none. */
    first(ids: Set<string>, after: (id: string) => number, counts: (e: Logged) => boolean): Logged | undefined {
      return events.find((e) => ids.has(e.id) && e.seq > after(e.id) && counts(e))
    },
    latest: (): number => seq,
    /** A caller that's gone: its place goes with it. */
    forget(caller: string): void {
      places.delete(caller)
    }
  }
}

export type WaitLog = ReturnType<typeof createWaitLog>

/**
 * The first thing among these agents past the caller's place: a report waiting for the caller, a turn ending, a stop
 * at a limit, or a node closed. Null at the timeout or when the caller goes away. See createWaitLog.
 */
export function nextChange({
  caller,
  ids,
  timeoutMs,
  pollMs,
  log,
  pending,
  exists,
  stopped,
  signal
}: {
  caller: string
  ids: string[]
  timeoutMs: number
  pollMs: number
  log: WaitLog
  /** The first of these agents with a message queued for the caller, already sent but not yet read. */
  pending: () => string | undefined
  exists: (id: string) => boolean
  /** Stopped on StopFailure, as at a usage limit. Learned a moment after the status changes, so it's also polled. */
  stopped: (id: string) => boolean
  signal?: AbortSignal
}): Promise<NextChange | null> {
  const watched = new Set(ids)
  const place = log.placeOf(caller)
  return new Promise((resolve) => {
    let over = false
    const finish = (change: NextChange | null, to?: number): void => {
      if (over) return
      over = true
      unsubscribe()
      clearInterval(timer)
      clearTimeout(limit)
      signal?.removeEventListener('abort', aborted)
      if (to !== undefined) place.set(ids, to)
      resolve(change)
    }
    const check = (): void => {
      const from = pending()
      if (from) return finish({ node: from, why: 'message' })
      const e = log.first(watched, place.of, (e) => SETTLED.has(e.status) || (e.status === 'unknown' && stopped(e.id)))
      if (e) return finish({ node: e.id, why: SETTLED.has(e.status) ? 'finished' : 'stopped' }, e.seq)
      const gone = ids.find((id) => !exists(id))
      if (gone) finish({ node: gone, why: 'closed' }, log.latest())
    }
    const unsubscribe = log.subscribe((e) => {
      // A message typed straight in, to a caller that wasn't busy (a terminal, say), never waits in its queue.
      if (e.type === 'message' && e.to === caller && watched.has(e.from)) return finish({ node: e.from, why: 'message' })
      check()
    })
    const timer = setInterval(check, pollMs)
    timer.unref?.()
    // Nothing happened for these agents up to now, so the next call starts from here.
    const limit = setTimeout(() => finish(null, log.latest()), timeoutMs)
    limit.unref?.()
    // The caller hung up: leave its place, and its reports, for the next call.
    const aborted = (): void => finish(null)
    if (signal?.aborted) return finish(null)
    signal?.addEventListener('abort', aborted)
    check()
  })
}
