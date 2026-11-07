import type { TriggerSchedule } from '../../shared/model'
import { nextCron, parseCron } from './cron'

/** Anything faster would only pile prompts onto a session. */
export const MIN_INTERVAL_MS = 5000
/** Counting stops here, since nobody needs to know it was exactly 40,000. */
export const MAX_COUNTED_SLOTS = 1000

/** What's wrong with a schedule, or null. A one-off in the past is judged when arming, since it was fine when written. */
export function scheduleError(s: TriggerSchedule): string | null {
  switch (s.type) {
    case 'cron': {
      const parsed = parseCron(s.expr)
      if (!parsed.ok) return parsed.error
      return nextCron(parsed.cron, Date.now()) === null ? 'That cron schedule never matches a real date.' : null
    }
    case 'interval':
      if (!Number.isFinite(s.everyMs)) return 'Give an interval.'
      return s.everyMs < MIN_INTERVAL_MS ? `The interval must be at least ${MIN_INTERVAL_MS / 1000} seconds.` : null
    case 'once':
      return Number.isFinite(s.at) ? null : 'Give a date and time.'
  }
}

/**
 * The first slot strictly after a time, or null if there are no more. Interval slots count from `anchor`, the time it
 * was armed, so running late or being run by hand doesn't shift them.
 */
export function nextRun(s: TriggerSchedule, after: number, anchor: number): number | null {
  switch (s.type) {
    case 'cron': {
      const parsed = parseCron(s.expr)
      return parsed.ok ? nextCron(parsed.cron, after) : null
    }
    case 'interval':
      if (!(s.everyMs >= MIN_INTERVAL_MS)) return null
      return after < anchor ? anchor + s.everyMs : anchor + (Math.floor((after - anchor) / s.everyMs) + 1) * s.everyMs
    case 'once':
      return s.at > after ? s.at : null
  }
}

/** The next few run times, for showing what arming agrees to. */
export function nextRuns(s: TriggerSchedule, after: number, anchor: number, count: number): number[] {
  const out: number[] = []
  let from = after
  while (out.length < count) {
    const next = nextRun(s, from, anchor)
    if (next === null) break
    out.push(next)
    from = next
  }
  return out
}

/** How many slots fall from `first` up to and including `until`, and when the last of them was. */
export function slotsUpTo(s: TriggerSchedule, first: number, until: number, anchor: number): { count: number; last: number; capped: boolean } {
  let count = 1
  let last = first
  while (count < MAX_COUNTED_SLOTS) {
    const next = nextRun(s, last, anchor)
    if (next === null || next > until) return { count, last, capped: false }
    last = next
    count++
  }
  return { count, last, capped: true }
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

export function describeInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second']
  ]
  const [size, unit] = units.find(([size]) => ms % size === 0) ?? [1000, 'second']
  const n = ms / size
  return n === 1 ? `Every ${unit}` : `Every ${plural(Math.round(n * 10) / 10, unit)}`
}

/** Says exactly what the schedule is, not a loose reading of it. */
export function describeSchedule(s: TriggerSchedule): string {
  switch (s.type) {
    case 'cron':
      return `Cron: ${s.expr.trim().replace(/\s+/g, ' ')} (local time)`
    case 'interval':
      return describeInterval(s.everyMs)
    case 'once':
      return `Once, at ${new Date(s.at).toLocaleString()}`
  }
}
