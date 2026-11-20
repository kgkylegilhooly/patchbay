import type { PlanUsage } from '../../shared/usage'

/**
 * What a Codex rollout file says about how its latest turn ended, for the same stop records and statuses Claude's
 * StopFailure gives (src/shared/agentStop.ts). Pure: src/main/sessions/codexStops.ts feeds it lines as they're added.
 *
 * Codex 0.170 has no StopFailure hook, and its Stop hook carries no error. What it does write to the rollout, from its
 * protocol (read from the 0.170 binary; see docs/plans/followups-integration.md):
 * - `event_msg` `task_started` / `task_complete`: a turn's start and end.
 * - `event_msg` `error`: `{ message, codex_error_info }`. The turn failed on it. `codex_error_info` is a snake_case
 *   name (`usage_limit_exceeded`, `server_overloaded`, ...) or an object with one such key.
 * - `event_msg` `turn_aborted`: `{ reason }`, `interrupted` when the person pressed Esc.
 * - `event_msg` `token_count`: `rate_limits.primary` / `.secondary` with `used_percent` and `resets_at` (unix
 *   seconds): the exact reset of a full window, as Claude's status line gives.
 * UNVERIFIED: whether 0.170 writes `error` and `turn_aborted` to the rollout in its default persistence mode, and
 * whether its Stop hook fires after a failed turn. Neither could be produced here (no Codex quota left); the tests use
 * written fixtures. If neither happens, nothing changes from before: the node is left as its hooks say.
 */

export interface CodexFailure {
  /** Claude's StopFailure `error` code this maps to, so the same stop kinds and holds apply. */
  error: string
  /** Codex's own name for it, kept for the record. */
  codexError: string | null
  message: string
  /** When the rollout line was written. */
  at: number | null
}

export interface CodexTurnState {
  /** A turn has started and not yet completed or been aborted. */
  inTurn: boolean
  /** The latest turn ended (completed or aborted). */
  ended: boolean
  /** The fatal error of the latest turn, if it had one. */
  failure: CodexFailure | null
  /** The latest turn was aborted, and why (`interrupted` for Esc). */
  aborted: { reason: string; at: number | null } | null
  /** The latest limits Codex reported, as Claude's plan windows: primary as the 5-hour, secondary as the weekly. */
  plan: PlanUsage | null
}

export const emptyCodexTurn = (): CodexTurnState => ({ inTurn: false, ended: false, failure: null, aborted: null, plan: null })

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Codex's error name, from `codex_error_info` as a string or as an object with one key. */
export function codexErrorName(info: unknown): string | null {
  if (typeof info === 'string') return info
  const o = obj(info)
  const keys = o ? Object.keys(o) : []
  return keys.length === 1 ? keys[0] : null
}

const SERVER = new Set([
  'server_overloaded', 'internal_server_error', 'http_connection_failed', 'response_stream_connection_failed', 'response_stream_disconnected',
  'response_too_many_failed_attempts', 'response_stream_failed', 'connection_failed', 'retry_limit', 'request_timeout', 'timeout', 'policy_capacity_unavailable', 'flex_unavailable'
])

/** The StopFailure `error` code a Codex error name means, as far as Patchbay's stop kinds go. */
export function claudeErrorFor(name: string | null, message: string): string {
  if (name === 'usage_limit_exceeded' || name === 'usage_limit_reached') return 'rate_limit'
  if (name === 'rate_limit_exceeded') return 'rate_limit'
  if (name === 'unauthorized' || name === 'refresh_token_failed') return 'authentication_failed'
  if (name === 'quota_exceeded' || name === 'usage_not_included') return 'billing_error'
  if (name && SERVER.has(name)) return 'server_error'
  // No name: the message alone, as for an old Claude hook. "You've hit your usage limit" reads as a limit.
  if (!name && /hit your usage limit/i.test(message)) return 'rate_limit'
  return name ?? 'error'
}

/** Limits from a `token_count` event, as plan windows. */
function planFrom(rateLimits: unknown, at: number): PlanUsage | null {
  const r = obj(rateLimits)
  if (!r) return null
  const window = (w: unknown) => {
    const o = obj(w)
    const percent = num(o?.used_percent)
    const resetsAt = num(o?.resets_at)
    return percent !== null && resetsAt !== null ? { percent, resetsAt } : undefined
  }
  const fiveHour = window(r.primary)
  const sevenDay = window(r.secondary)
  if (!fiveHour && !sevenDay) return null
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at }
}

/** Folds one rollout line into the state. Lines that aren't events, or don't parse, change nothing. */
export function foldCodexLine(state: CodexTurnState, text: string): CodexTurnState {
  if (!text.includes('"event_msg"')) return state
  let line: Record<string, unknown> | null
  try {
    line = obj(JSON.parse(text))
  } catch {
    return state
  }
  if (line?.type !== 'event_msg') return state
  const p = obj(line.payload)
  if (!p) return state
  const at = typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp)) ? Date.parse(line.timestamp) : null
  switch (p.type) {
    case 'task_started':
      return { ...state, inTurn: true, ended: false, failure: null, aborted: null }
    case 'task_complete':
      return { ...state, inTurn: false, ended: true }
    case 'turn_aborted':
      return { ...state, inTurn: false, ended: true, aborted: { reason: typeof p.reason === 'string' ? p.reason : 'unknown', at } }
    case 'error': {
      const message = typeof p.message === 'string' ? p.message : ''
      const codexError = codexErrorName(p.codex_error_info)
      return { ...state, failure: { error: claudeErrorFor(codexError, message), codexError, message, at } }
    }
    case 'token_count': {
      const plan = planFrom(p.rate_limits, at ?? Date.now())
      return plan ? { ...state, plan } : state
    }
    default:
      return state
  }
}

/**
 * The StopFailure a failed Codex turn stands for, with the fields Claude's hook would have sent, or null when the
 * turn didn't fail. The rollout's own time is kept, so a reset such as "try again at 3:45 PM" is read against it.
 */
export function codexStopFailure(state: CodexTurnState): Record<string, unknown> | null {
  const f = state.failure
  if (!f) return null
  // Codex's usage-limit text always says so, but its error name is what's certain: say it, so it reads as one.
  const limit = f.codexError?.startsWith('usage_limit') && !/usage limit/i.test(f.message)
  return { hook_event_name: 'StopFailure', error: f.error, error_details: limit ? `Usage limit reached. ${f.message}`.trim() : f.message, ...(f.codexError ? { codex_error: f.codexError } : {}), ...(f.at !== null ? { at: f.at } : {}) }
}
