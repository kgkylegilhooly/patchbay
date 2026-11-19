import { RELEASE_MARGIN_MS, stopFromHook, stopHolds, type AgentStop } from '../../shared/agentStop'
import type { PlanUsage } from '../../shared/usage'
import type { SendQueue } from '../control/sendQueue'
import type { StatusTracker } from './statusTracker'

/** setTimeout's longest wait. A weekly limit's reset is further off than this only in theory, so it just looks again. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface AgentStops {
  /** The node's stop, while its status is still the `unknown` that StopFailure left. */
  get(id: string): AgentStop | undefined
  all(): Record<string, AgentStop>
  /** Call with each hook after the status tracker has had it, journalled ones included. Only StopFailure records anything. */
  noteHook(id: string, payload: Record<string, unknown>): void
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
  /** Settings changed, so what each stop shows may have. */
  refresh(): void
  dispose(): void
}

export function createAgentStops({
  tracker,
  plan = () => null,
  continueEnabled = () => false,
  now = Date.now
}: {
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  /** The status line's latest plan limits, for an exact reset time. */
  plan?: () => PlanUsage | null
  /** Settings > Sessions > Continue after a usage limit resets. */
  continueEnabled?: () => boolean
  now?: () => number
}): AgentStops {
  const stops = new Map<string, AgentStop>()
  const timers = new Map<string, NodeJS.Timeout>()
  /** Continued at a reset and not yet through a turn that ended normally. */
  const continued = new Set<string>()
  const changeListeners: Array<(id: string, stop: AgentStop | null) => void> = []
  const releaseListeners: Array<(id: string, stop: AgentStop) => void> = []

  const view = (id: string, stop: AgentStop): AgentStop => ({
    ...stop,
    willContinue: stop.holds === 'reset' && continueEnabled() && !continued.has(id)
  })
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
    if (stop.holds !== 'reset' || stop.until === null) return
    const due = stop.until + RELEASE_MARGIN_MS
    const timer = setTimeout(() => {
      timers.delete(id)
      if (stops.get(id) !== stop) return
      // Late, as after the PC slept, is fine. Early, as when the wait was capped or the clock moved, looks again.
      if (now() < due) return armRelease(id, stop)
      changed(id)
      for (const cb of releaseListeners) cb(id, view(id, stop))
    }, Math.min(MAX_TIMER_MS, Math.max(0, due - now())))
    timer.unref?.()
    timers.set(id, timer)
  }

  const clear = (id: string): void => {
    stopTimer(id)
    if (stops.delete(id)) changed(id)
  }

  tracker.onChange((id, status) => {
    // Any move off `unknown` is newer news than the stop: the person typed, a tool ran, the turn ended or it exited.
    if (status !== 'unknown') clear(id)
    if (status === 'idle' || status === 'exited') continued.delete(id)
  })

  return {
    get(id) {
      const stop = stops.get(id)
      return stop && view(id, stop)
    },
    all: () => Object.fromEntries([...stops].map(([id, stop]) => [id, view(id, stop)])),
    noteHook(id, payload) {
      if (payload.hook_event_name !== 'StopFailure') return
      // Only a hook the tracker took: StopFailure sets `unknown`, and an exited or unknown node is left as it was.
      if (tracker.get(id) !== 'unknown') return
      // A journalled event says when it happened, which a reset time such as "12:30am" is read against.
      const at = typeof payload.at === 'number' && payload.at <= now() ? payload.at : now()
      const stop = stopFromHook(payload, at, plan())
      stops.set(id, stop)
      armRelease(id, stop)
      changed(id)
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
      if (stops.has(id)) changed(id)
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
