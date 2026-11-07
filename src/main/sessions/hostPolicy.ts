/**
 * When a host with nobody connected ends by itself. Time only counts while the PC is awake, so coming back
 * from a long sleep or a holiday never ends sessions in the moment before the owner can reopen the app.
 * Any connected app stops every clock, so none of this can happen during ordinary use.
 */

/** Running sessions with no app for a week of awake time are treated as forgotten. Their scrollback is saved first. */
export const HOST_ORPHAN_MS = 7 * 24 * 60 * 60 * 1000
/** Nothing running and no app: there's nothing left to protect, so the host needn't linger. */
export const HOST_EMPTY_MS = 10 * 60 * 1000
/** The profile was deleted or replaced, so no app can ever reconnect to these sessions. */
export const HOST_DATA_GONE_MS = 10 * 60 * 1000
export const HOST_TICK_MS = 60 * 1000

export interface HostLimits {
  orphanMs: number
  emptyMs: number
  dataGoneMs: number
  tickMs: number
}

export const DEFAULT_HOST_LIMITS: HostLimits = {
  orphanMs: HOST_ORPHAN_MS,
  emptyMs: HOST_EMPTY_MS,
  dataGoneMs: HOST_DATA_GONE_MS,
  tickMs: HOST_TICK_MS
}

/** Acceptance runs shorten these with PATCHBAY_HOST_LIMITS. Anything unusable falls back to the defaults. */
export function limitsFrom(text: string | undefined): HostLimits {
  if (!text) return DEFAULT_HOST_LIMITS
  try {
    const parsed = JSON.parse(text) as Partial<Record<keyof HostLimits, unknown>>
    const pick = (key: keyof HostLimits): number => {
      const value = parsed[key]
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_HOST_LIMITS[key]
    }
    return { orphanMs: pick('orphanMs'), emptyMs: pick('emptyMs'), dataGoneMs: pick('dataGoneMs'), tickMs: pick('tickMs') }
  } catch {
    return DEFAULT_HOST_LIMITS
  }
}

export interface HostPolicyState {
  lastTick: number
  /** Awake time with no app connected. */
  away: number
  /** Awake time with no app and nothing running. */
  empty: number
  /** Awake time with no app and the profile missing. */
  dataGone: number
}

export type HostExitReason = 'orphaned' | 'empty' | 'data-gone'

export function startPolicy(now: number): HostPolicyState {
  return { lastTick: now, away: 0, empty: 0, dataGone: 0 }
}

/** Pure. One tick's look at the host: what to remember, and whether it should now end. */
export function stepPolicy(
  state: HostPolicyState,
  seen: { now: number; connected: boolean; running: number; dataPresent: boolean },
  limits: HostLimits = DEFAULT_HOST_LIMITS
): { state: HostPolicyState; exit: HostExitReason | null } {
  if (seen.connected) return { state: startPolicy(seen.now), exit: null }
  // A gap much longer than a tick means the PC slept. Only the tick's own worth of it counts as awake.
  const awake = Math.min(Math.max(seen.now - state.lastTick, 0), limits.tickMs * 2)
  const next: HostPolicyState = {
    lastTick: seen.now,
    away: state.away + awake,
    empty: seen.running === 0 ? state.empty + awake : 0,
    dataGone: seen.dataPresent ? 0 : state.dataGone + awake
  }
  if (next.dataGone >= limits.dataGoneMs) return { state: next, exit: 'data-gone' }
  if (next.empty >= limits.emptyMs) return { state: next, exit: 'empty' }
  if (seen.running > 0 && next.away >= limits.orphanMs) return { state: next, exit: 'orphaned' }
  return { state: next, exit: null }
}
