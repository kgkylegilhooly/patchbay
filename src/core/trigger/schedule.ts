import type { TriggerSchedule } from '../../shared/model'
import { nextCron, parseCron } from './cron'
import { describeEvent, eventShapeError, isEventSchedule } from './events'
import { describeWindow, windowOf, type TriggerWindow } from './window'

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
    default:
      return eventShapeError(s)
  }
}

/**
 * The first slot strictly after a time, or null if there are no more. Interval slots count from `anchor`, the time it
 * was armed, so running late or being run by hand doesn't shift them.
 *
 * With a window (see window.ts), nothing falls before its start or after its end, which itself can be a slot. An
 * interval with a start counts from the start instead, and the start is its first slot: every 5 minutes from 14:00 is
 * 14:00, 14:05 and so on, whenever it was armed. Slots are counted in milliseconds, so a clock change doesn't move them.
 */
export function nextRun(s: TriggerSchedule, after: number, anchor: number, w?: TriggerWindow): number | null {
  const win = w ? windowOf({ schedule: s, ...w }) : null
  const start = win?.start ?? null
  const next = ((): number | null => {
    switch (s.type) {
      case 'cron': {
        const parsed = parseCron(s.expr)
        // nextCron is strictly after, so asking from just before the start lets the start itself be a slot.
        return parsed.ok ? nextCron(parsed.cron, start !== null && after < start ? start - 1 : after) : null
      }
      case 'interval':
        if (!(s.everyMs >= MIN_INTERVAL_MS)) return null
        if (start !== null) return after < start ? start : start + (Math.floor((after - start) / s.everyMs) + 1) * s.everyMs
        return after < anchor ? anchor + s.everyMs : anchor + (Math.floor((after - anchor) / s.everyMs) + 1) * s.everyMs
      case 'once':
        return s.at > after ? s.at : null
      default:
        // An event has no times: it fires when it happens.
        return null
    }
  })()
  return next !== null && win?.end != null && next > win.end ? null : next
}

/** The next few run times, for showing what arming agrees to. */
export function nextRuns(s: TriggerSchedule, after: number, anchor: number, count: number, w?: TriggerWindow): number[] {
  const out: number[] = []
  let from = after
  while (out.length < count) {
    const next = nextRun(s, from, anchor, w)
    if (next === null) break
    out.push(next)
    from = next
  }
  return out
}

/**
 * Whether its window has closed for good: the end has passed, or no slot is left before it. Such a trigger is finished,
 * not broken.
 */
export function windowEnded(node: { schedule: TriggerSchedule } & TriggerWindow, now: number): boolean {
  const end = windowOf(node)?.end ?? null
  if (end === null) return false
  if (end <= now) return true
  return !isEventSchedule(node.schedule) && nextRun(node.schedule, now, now, node) === null
}

/** How many slots fall from `first` up to and including `until`, and when the last of them was. None after the end. */
export function slotsUpTo(s: TriggerSchedule, first: number, until: number, anchor: number, w?: TriggerWindow): { count: number; last: number; capped: boolean } {
  let count = 1
  let last = first
  while (count < MAX_COUNTED_SLOTS) {
    const next = nextRun(s, last, anchor, w)
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

/**
 * Says exactly what the schedule is, not a loose reading of it. `name` gives a node's title, for an event from a node.
 * A window follows: "Every 5 minutes, from 21 Nov 14:00 until 22 Nov 09:00".
 */
export function describeSchedule(s: TriggerSchedule, name?: (id: string) => string | undefined, w?: TriggerWindow): string {
  return describeWhat(s, name) + (w ? describeWindow(windowOf({ schedule: s, ...w })) : '')
}

function describeWhat(s: TriggerSchedule, name?: (id: string) => string | undefined): string {
  switch (s.type) {
    case 'cron':
      return `Cron: ${s.expr.trim().replace(/\s+/g, ' ')} (local time)`
    case 'interval':
      return describeInterval(s.everyMs)
    case 'once':
      return `Once, at ${new Date(s.at).toLocaleString()}`
    default:
      return describeEvent(s, name)
  }
}
