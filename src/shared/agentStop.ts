import type { PlanUsage } from './usage'

/**
 * Why a Claude turn ended on StopFailure rather than Stop, as its hook said. The node's status stays `unknown`, since
 * Patchbay can't vouch for more than the hook told it; this says what the hook did tell it.
 */
export type StopKind = 'usage-limit' | 'rate-limit' | 'auth' | 'billing' | 'server' | 'error'

export interface AgentStop {
  kind: StopKind
  /** When the hook arrived. */
  at: number
  /** When the limit resets, in ms, if known. Only limits have one. */
  until: number | null
  /** What Claude said, such as "You've hit your 5-hour limit · resets 12:30am". Capped. */
  message: string | null
  /**
   * What messages and trigger prompts for it wait for: the reset time, the node moving again (as when the person types
   * or logs in), or nothing, when the agent is at its prompt and a new message simply tries again.
   */
  holds: 'reset' | 'person' | null
  /** Settings say to send "continue" once at the reset, and this stop qualifies. */
  willContinue?: boolean
  /**
   * A rate limit that named no reset time, such as a short burst of 429s: `until` is a guess, a short wait after which
   * messages are tried again. Another limit straight after records a new stop that waits longer.
   */
  retry?: true
}

/** Messages wait this long past a reset time, which the message gives only to the minute. */
export const RELEASE_MARGIN_MS = 30_000
/** How long a rate limit with no reset time holds messages at first. Each one straight after it doubles this. */
export const RETRY_FIRST_MS = 60_000
export const RETRY_MAX_MS = 15 * 60_000
const MESSAGE_CHARS = 500

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESET_TEXT =
  /\b(?:resets?|try again)\s+(?:at\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i

/**
 * The next local time a message such as "resets 12:30am" or "resets Nov 21, 9am" names, after `after`. Null when it
 * names none. A bare number needs am/pm or minutes to count, so "resets 5" isn't read as 5 o'clock. Codex says it as
 * "try again at 3:45 PM" or "try again at Nov 21st, 2026 3:45 PM", which reads the same way.
 */
export function parseResetTime(text: string, after: number, localZone = localTimeZone()): number | null {
  const m = RESET_TEXT.exec(text)
  if (!m) return null
  const [, month, day, year, hourText, minuteText, half] = m
  if (!half && minuteText === undefined) return null
  let hour = Number(hourText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  if (minute > 59 || (half ? hour < 1 || hour > 12 : hour > 23)) return null
  if (half) hour = (hour % 12) + (half.toLowerCase() === 'pm' ? 12 : 0)
  // "resets 12:30am (Europe/London)": a time in a zone other than this PC's is read in that zone.
  const zone = ZONE_TEXT.exec(text.slice(m.index + m[0].length))?.[1]
  if (zone && zone !== localZone) return inZone(zone, after, month ? MONTHS.indexOf(month.toLowerCase()) : null, Number(day), hour, minute)
  const base = new Date(after)
  if (month) {
    const at = new Date(year ? Number(year) : base.getFullYear(), MONTHS.indexOf(month.toLowerCase()), Number(day), hour, minute)
    // "Jan 2" seen on Dec 30 is next year's. A year that's given is taken as it is.
    if (!year && at.getTime() <= after) at.setFullYear(at.getFullYear() + 1)
    return at.getTime()
  }
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute)
  if (at.getTime() <= after) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const ZONE_TEXT = /^\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\)/

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** How far a zone's wall clock is ahead of UTC at a moment, in ms. Null for a zone Intl doesn't know. */
function zoneOffset(zone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at)
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000
  } catch {
    return null
  }
}

/** The next time after `after` that a zone's clock shows this, as parseResetTime does for local time. */
function inZone(zone: string, after: number, month: number | null, day: number, hour: number, minute: number): number | null {
  const offset = zoneOffset(zone, after)
  if (offset === null) return null
  const wall = new Date(after + offset)
  const y = wall.getUTCFullYear()
  let at = month !== null ? Date.UTC(y, month, day, hour, minute) : Date.UTC(y, wall.getUTCMonth(), wall.getUTCDate(), hour, minute)
  if (at <= after + offset) at = month !== null ? Date.UTC(y + 1, month, day, hour, minute) : Date.UTC(y, wall.getUTCMonth(), wall.getUTCDate() + 1, hour, minute)
  return at - (zoneOffset(zone, at - offset) ?? offset)
}

/** A plan window at its limit that resets after the failure: the exact time, from the status line. */
function fullWindowReset(plan: PlanUsage | null | undefined, after: number): number | null {
  const resets = [plan?.fiveHour, plan?.sevenDay]
    .filter((w) => w && w.percent >= 100 && w.resetsAt * 1000 > after)
    .map((w) => w!.resetsAt * 1000)
  return resets.length ? Math.max(...resets) : null
}

const LIMIT_WORDS = /\b(usage limit|(5|five)-hour limit|weekly limit|session limit|limit reached|hit your .*limit|out of (extra )?usage)\b/i

function kindOf(error: string, message: string): StopKind {
  const e = error.toLowerCase()
  if (e === 'rate_limit' || e === 'rate_limited') return LIMIT_WORDS.test(message) || /\bresets?\b/i.test(message) ? 'usage-limit' : 'rate-limit'
  if (e === 'authentication_failed' || e === 'oauth_error' || e === 'unauthorized') return 'auth'
  if (e === 'billing_error') return 'billing'
  if (e === 'server_error' || e === 'overloaded' || e === 'overloaded_error' || e === 'api_error') return 'server'
  // An older hook script forwards no error, so the message is all there is.
  if (LIMIT_WORDS.test(message)) return 'usage-limit'
  return 'error'
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** What a StopFailure hook's fields say happened, using the status line's limits for the reset time where it can. */
export function stopFromHook(payload: Record<string, unknown>, at: number, plan?: PlanUsage | null, retryMs = RETRY_FIRST_MS): AgentStop {
  const said = [text(payload.last_assistant_message), text(payload.error_details)].filter(Boolean).join('\n')
  const kind = kindOf(text(payload.error), said)
  const limit = kind === 'usage-limit' || kind === 'rate-limit'
  const until = limit ? (fullWindowReset(plan, at) ?? parseResetTime(said, at)) : null
  const stop: AgentStop = {
    kind,
    at,
    until,
    message: said ? said.slice(0, MESSAGE_CHARS) : null,
    holds: limit ? (until !== null ? 'reset' : 'person') : kind === 'auth' || kind === 'billing' ? 'person' : null
  }
  // A short rate limit clears by itself, so messages are tried again soon rather than left for the person.
  if (kind === 'rate-limit' && until === null) return { ...stop, until: at + retryMs, holds: 'reset', retry: true }
  return stop
}

/** When messages held for it may go: a little after a stated reset, which is given to the minute, or at a retry. */
export function releaseAt(stop: AgentStop): number | null {
  if (stop.holds !== 'reset' || stop.until === null) return null
  return stop.until + (stop.retry ? 0 : RELEASE_MARGIN_MS)
}

/** Whether messages for a node stopped like this wait now. */
export function stopHolds(stop: AgentStop, now: number): boolean {
  if (stop.holds === 'person') return true
  const release = releaseAt(stop)
  return release !== null && now < release
}

const pad = (n: number): string => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "00:30" within the next day, else "Fri 09:00". Local time, 24-hour. */
export function clockTime(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return Math.abs(at - now) < 20 * 3600_000 ? hm : `${DAYS[d.getDay()]} ${hm}`
}

const NAMES: Record<StopKind, string> = {
  'usage-limit': 'Usage limit',
  'rate-limit': 'Rate limited',
  auth: 'Login failed',
  billing: 'Billing problem',
  server: 'Server error',
  error: 'Stopped on an error'
}

/**
 * Whether a Continue button can get the agent going again: a server or unknown error that left it at its prompt, where
 * a new message simply tries again. Not a limit (it waits for its reset, and may continue by itself) nor a login or
 * billing failure, which the person has to fix first.
 */
export function canContinue(stop: AgentStop | undefined): boolean {
  return !!stop && (stop.kind === 'server' || stop.kind === 'error') && stop.holds === null
}

/** A few words for a badge: "Usage limit until 00:30", "Usage limit reset at 00:30", "Login failed". */
export function stopLabel(stop: AgentStop, now: number): string {
  const name = NAMES[stop.kind]
  if (stop.until === null) return name
  const time = clockTime(stop.until, now)
  if (stop.retry) return now < stop.until ? `${name}, retrying at ${time}` : name
  if (now >= stop.until) return `${name} reset at ${time}`
  return `${name} until ${time}${stop.willContinue ? ' · continues then' : ''}`
}

/** For an agent reading `wait`, `send` or `list`: what happened, and what Patchbay does about messages to it. */
export function stopExplained(stop: AgentStop, now: number): string {
  const label = stopLabel(stop, now)
  if (stop.holds === 'reset' && stopHolds(stop, now))
    return `${label}. Messages and trigger prompts for it wait until then and go out by themselves${stop.willContinue ? ', and it gets "continue" if nothing is waiting' : ''}${stop.retry ? '; another limit holds them longer' : ''}. Its work so far stays on disk. Held messages don't survive Patchbay restarting, so if it restarts first, send again.`
  if (stop.holds === 'person') return `${label}. Messages for it wait until it's working again, which needs the person. Tell them which node.`
  return `${label}. It's back at its prompt, so a message starts it again.`
}

/** For a trigger run held for a stopped node, or null when nothing holds it. */
export function heldReason(stop: AgentStop, now: number): string | null {
  if (!stopHolds(stop, now)) return null
  const label = stopLabel(stop, now)
  return stop.holds === 'reset' ? `${label}. It goes out then` : `${label}. It goes out once it's working again`
}

/** The window's view of stops, as `window.patchbayStops`. */
export interface AgentStopBridge {
  all(): Promise<Record<string, AgentStop>>
  onChange(cb: (id: string, stop: AgentStop | null) => void): () => void
}
