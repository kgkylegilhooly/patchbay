import { readIfPresentSync, writeAtomic } from '../../core/persist/atomicFile'
import { releaseAt, RETRY_FIRST_MS, RETRY_MAX_MS, stopFromHook, stopHolds, type AgentStop, type StopKind } from '../../shared/agentStop'
import type { PlanUsage } from '../../shared/usage'
import type { SendQueue } from '../control/sendQueue'
import type { StatusTracker } from './statusTracker'

/**
 * The longest single wait before the clock is looked at again. One long timer can fire hours late after the PC sleeps,
 * since timers count time awake, so a reset is checked at least this often and lands within this of waking.
 */
const RECHECK_MS = 60_000
/** A saved stop older than this is dropped at start: no limit lasts longer. */
const SAVED_FOR_MS = 8 * 86400_000

export interface AgentStops {
  /** The node's stop, while its status is still the `unknown` that StopFailure left. */
  get(id: string): AgentStop | undefined
  all(): Record<string, AgentStop>
  /**
   * Call with each hook after the status tracker has had it, journalled ones included. Only StopFailure records
   * anything. `limits` replaces the status line's plan limits for the reset time, as Codex's own rollout gives them.
   */
  noteHook(id: string, payload: Record<string, unknown>, limits?: PlanUsage | null): void
  /** Messages for it wait now, even if it were idle. */
  holding(id: string): boolean
  /** Stopped at its prompt and no longer held, so a message may be typed though its status is `unknown`. */
  released(id: string): boolean
  /** A stop was recorded, changed what it shows, or ended (null). */
  onChange(cb: (id: string, stop: AgentStop | null) => void): void
  /** A limit's reset time has passed, or a stop that holds nothing was recorded. */
  onRelease(cb: (id: string, stop: AgentStop) => void): void
  /** Notes that "continue" was sent at a reset, so a stop right after it isn't continued again. */
  markContinued(id: string): void
  /**
   * After an app restart, keeps the saved stops of these nodes only: the sessions it reconnected to, still `unknown`.
   * Anything else ended or was closed while the app was away.
   */
  retain(ids: string[]): void
  /** Settings changed, so what each stop shows may have. */
  refresh(): void
  dispose(): void
}

/** What's kept on disk, so a restart of the app doesn't forget a node is at its limit. */
export interface SavedStops {
  stops: Record<string, AgentStop>
  continued: string[]
}

export interface StopStore {
  load(): SavedStops | null
  save(saved: SavedStops): void
}

const KINDS: StopKind[] = ['usage-limit', 'rate-limit', 'auth', 'billing', 'server', 'error']

/** Only well-formed stops are taken back. A damaged file means none. */
function validStop(v: unknown): AgentStop | null {
  const s = v as Partial<AgentStop> | null
  if (!s || typeof s !== 'object' || !KINDS.includes(s.kind as StopKind) || typeof s.at !== 'number') return null
  if (s.until !== null && typeof s.until !== 'number') return null
  if (s.holds !== null && s.holds !== 'reset' && s.holds !== 'person') return null
  return { kind: s.kind!, at: s.at, until: s.until ?? null, message: typeof s.message === 'string' ? s.message : null, holds: s.holds ?? null, ...(s.retry ? { retry: true as const } : {}) }
}

/** A JSON file, written whole each time and one write at a time. */
export function stopFile(path: string, log?: (line: string) => void): StopStore {
  let writing = Promise.resolve()
  return {
    load() {
      try {
        const raw = JSON.parse(readIfPresentSync(path) ?? 'null') as { stops?: Record<string, unknown>; continued?: unknown } | null
        if (!raw || typeof raw !== 'object') return null
        const stops: Record<string, AgentStop> = {}
        for (const [id, v] of Object.entries(raw.stops ?? {})) {
          const stop = validStop(v)
          if (stop) stops[id] = stop
        }
        return { stops, continued: Array.isArray(raw.continued) ? raw.continued.filter((id): id is string => typeof id === 'string') : [] }
      } catch (e) {
        log?.(`Saved agent stops couldn't be read: ${(e as Error).message}`)
        return null
      }
    },
    save(saved) {
      const text = JSON.stringify(saved)
      writing = writing.then(() => writeAtomic(path, text)).catch((e: unknown) => log?.(`Agent stops couldn't be saved: ${String(e)}`))
    }
  }
}

export function createAgentStops({
  tracker,
  plan = () => null,
  continueEnabled = () => false,
  store,
  now = Date.now
}: {
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  /** The status line's latest plan limits, for an exact reset time. */
  plan?: () => PlanUsage | null
  /** Settings > Sessions > Continue after a usage limit resets. */
  continueEnabled?: () => boolean
  /** Where stops are kept across app restarts. Memory only without one. */
  store?: StopStore
  now?: () => number
}): AgentStops {
  const stops = new Map<string, AgentStop>()
  const timers = new Map<string, NodeJS.Timeout>()
  /** Continued at a reset and not yet through a turn that ended normally. */
  const continued = new Set<string>()
  /** The last retry wait for a rate limit with no reset time, doubled by another straight after it. */
  const lastRetry = new Map<string, number>()
  const changeListeners: Array<(id: string, stop: AgentStop | null) => void> = []
  const releaseListeners: Array<(id: string, stop: AgentStop) => void> = []

  const view = (id: string, stop: AgentStop): AgentStop => ({
    ...stop,
    willContinue: stop.holds === 'reset' && !stop.retry && continueEnabled() && !continued.has(id)
  })
  const save = (): void => store?.save({ stops: Object.fromEntries(stops), continued: [...continued] })
  const changed = (id: string): void => {
    const stop = stops.get(id)
    for (const cb of changeListeners) cb(id, stop ? view(id, stop) : null)
  }

  const stopTimer = (id: string): void => {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
  }

  const armRelease = (id: string, stop: AgentStop): void => {
    stopTimer(id)
    const due = releaseAt(stop)
    if (due === null) return
    const timer = setTimeout(() => {
      timers.delete(id)
      if (stops.get(id) !== stop) return
      if (now() < due) return armRelease(id, stop)
      changed(id)
      for (const cb of releaseListeners) cb(id, view(id, stop))
    }, Math.min(RECHECK_MS, Math.max(0, due - now())))
    timer.unref?.()
    timers.set(id, timer)
  }

  const clear = (id: string): void => {
    stopTimer(id)
    if (!stops.delete(id)) return
    changed(id)
    save()
  }

  const saved = store?.load()
  if (saved) {
    for (const [id, stop] of Object.entries(saved.stops)) {
      // Its release is armed by retain, once it's known which sessions came back.
      if (now() - stop.at <= SAVED_FOR_MS) stops.set(id, stop)
    }
    for (const id of saved.continued) continued.add(id)
  }

  tracker.onChange((id, status) => {
    // Any move off `unknown` is newer news than the stop: the person typed, a tool ran, the turn ended or it exited.
    if (status !== 'unknown') clear(id)
    if (status === 'idle' || status === 'exited') {
      lastRetry.delete(id)
      if (continued.delete(id)) save()
    }
  })

  return {
    get(id) {
      const stop = stops.get(id)
      return stop && view(id, stop)
    },
    all: () => Object.fromEntries([...stops].map(([id, stop]) => [id, view(id, stop)])),
    noteHook(id, payload, limits) {
      if (payload.hook_event_name !== 'StopFailure') return
      // Only a hook the tracker took: StopFailure sets `unknown`, and an exited or unknown node is left as it was.
      if (tracker.get(id) !== 'unknown') return
      // A journalled event says when it happened, which a reset time such as "12:30am" is read against.
      const at = typeof payload.at === 'number' && payload.at <= now() ? payload.at : now()
      const retryMs = Math.min(RETRY_MAX_MS, lastRetry.has(id) ? lastRetry.get(id)! * 2 : RETRY_FIRST_MS)
      const stop = stopFromHook(payload, at, limits !== undefined ? limits : plan(), retryMs)
      if (stop.retry) lastRetry.set(id, retryMs)
      stops.set(id, stop)
      armRelease(id, stop)
      changed(id)
      save()
      // Nothing to wait for, as after a server error: it's at its prompt now.
      if (!stopHolds(stop, now())) for (const cb of releaseListeners) cb(id, view(id, stop))
    },
    holding(id) {
      const stop = stops.get(id)
      return !!stop && stopHolds(stop, now())
    },
    released(id) {
      const stop = stops.get(id)
      return !!stop && !stopHolds(stop, now())
    },
    onChange(cb) {
      changeListeners.push(cb)
    },
    onRelease(cb) {
      releaseListeners.push(cb)
    },
    markContinued(id) {
      continued.add(id)
      save()
      if (stops.has(id)) changed(id)
    },
    retain(ids) {
      const keep = new Set(ids)
      let dropped = false
      for (const [id, stop] of [...stops]) {
        if (keep.has(id) && tracker.get(id) === 'unknown') {
          if (!timers.has(id)) armRelease(id, stop)
          continue
        }
        stopTimer(id)
        stops.delete(id)
        changed(id)
        dropped = true
      }
      if (dropped) save()
    },
    refresh() {
      for (const id of stops.keys()) changed(id)
    },
    dispose() {
      for (const id of [...timers.keys()]) stopTimer(id)
    }
  }
}

/**
 * Settings > Sessions > Continue after a usage limit resets: at the reset, a node still stopped on that limit, with
 * nothing of its own waiting to go to it, gets "continue" once. Call after the queue exists, so the queue's own
 * messages go first and this sees them.
 */
export function continueAtReset(stops: AgentStops, queue: Pick<SendQueue, 'add' | 'busy'>): void {
  stops.onRelease((id, stop) => {
    if (!stop.willContinue || queue.busy(id)) return
    stops.markContinued(id)
    queue.add(id, { text: 'continue' })
  })
}
