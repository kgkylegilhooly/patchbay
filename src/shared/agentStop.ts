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
}

/** Messages wait this long past a reset time, which the message gives only to the minute. */
export const RELEASE_MARGIN_MS = 30_000
const MESSAGE_CHARS = 500

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESET_TEXT =
  /\bresets?\s+(?:at\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i

/**
 * The next local time a message such as "resets 12:30am" or "resets Nov 21, 9am" names, after `after`. Null when it
 * names none. A bare number needs am/pm or minutes to count, so "resets 5" isn't read as 5 o'clock.
 */
export function parseResetTime(text: string, after: number): number | null {
  const m = RESET_TEXT.exec(text)
  if (!m) return null
  const [, month, day, hourText, minuteText, half] = m
  if (!half && minuteText === undefined) return null
  let hour = Number(hourText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  if (minute > 59 || (half ? hour < 1 || hour > 12 : hour > 23)) return null
  if (half) hour = (hour % 12) + (half.toLowerCase() === 'pm' ? 12 : 0)
  const base = new Date(after)
  if (month) {
    const at = new Date(base.getFullYear(), MONTHS.indexOf(month.toLowerCase()), Number(day), hour, minute)
    // "Jan 2" seen on Dec 30 is next year's.
    if (at.getTime() <= after) at.setFullYear(at.getFullYear() + 1)
    return at.getTime()
  }
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute)
  if (at.getTime() <= after) at.setDate(at.getDate() + 1)
  return at.getTime()
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
export function stopFromHook(payload: Record<string, unknown>, at: number, plan?: PlanUsage | null): AgentStop {
  const said = [text(payload.last_assistant_message), text(payload.error_details)].filter(Boolean).join('\n')
  const kind = kindOf(text(payload.error), said)
  const limit = kind === 'usage-limit' || kind === 'rate-limit'
  const until = limit ? (fullWindowReset(plan, at) ?? parseResetTime(said, at)) : null
  return {
    kind,
    at,
    until,
    message: said ? said.slice(0, MESSAGE_CHARS) : null,
    holds: limit ? (until !== null ? 'reset' : 'person') : kind === 'auth' || kind === 'billing' ? 'person' : null
  }
}

/** Whether messages for a node stopped like this wait now. */
export function stopHolds(stop: AgentStop, now: number): boolean {
  if (stop.holds === 'person') return true
  return stop.holds === 'reset' && stop.until !== null && now < stop.until + RELEASE_MARGIN_MS
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

/** A few words for a badge: "Usage limit until 00:30", "Usage limit reset at 00:30", "Login failed". */
export function stopLabel(stop: AgentStop, now: number): string {
  const name = NAMES[stop.kind]
  if (stop.until === null) return name
  const time = clockTime(stop.until, now)
  if (now >= stop.until) return `${name} reset at ${time}`
  return `${name} until ${time}${stop.willContinue ? ' · continues then' : ''}`
}

/** For an agent reading `wait`, `send` or `list`: what happened, and what Patchbay does about messages to it. */
export function stopExplained(stop: AgentStop, now: number): string {
  const label = stopLabel(stop, now)
  if (stop.holds === 'reset' && stopHolds(stop, now))
    return `${label}. Messages and trigger prompts for it wait until then and go out by themselves${stop.willContinue ? ', and it gets "continue" if nothing is waiting' : ''}. Its work so far stays on disk.`
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
