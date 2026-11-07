/**
 * Five-field cron: minute, hour, day of month, month, day of week, in local time.
 *
 * Each field takes `*`, numbers, ranges, lists and steps (a, a-b, *\/n, a-b/n, a/n), and month and weekday also take
 * names. Sunday is 0 or 7. As in standard cron, when day of month and day of week are both restricted, either can match.
 * A field that starts with `*`, as in `*\/2`, doesn't count as restricted.
 *
 * Times follow the wall clock. When clocks go forward, a time inside the skipped hour doesn't run that day. When they
 * go back, a time inside the repeated hour runs twice.
 */
export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  dayRestricted: boolean
  weekdayRestricted: boolean
}

export type CronResult = { ok: true; cron: Cron } | { ok: false; error: string }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  label: string
  min: number
  max: number
  names?: string[]
  /** What the first name stands for. */
  nameBase?: number
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { label: 'day of week', min: 0, max: 7, names: WEEKDAYS, nameBase: 0 }
]

class CronError extends Error {}

function value(text: string, spec: FieldSpec): number {
  const index = spec.names?.indexOf(text.toLowerCase()) ?? -1
  if (index >= 0) return index + (spec.nameBase ?? 0)
  if (!/^\d+$/.test(text)) throw new CronError(`The ${spec.label} field has "${text}", which isn't a number${spec.names ? ' or a name' : ''}.`)
  const n = Number(text)
  if (n < spec.min || n > spec.max) throw new CronError(`The ${spec.label} field must be from ${spec.min} to ${spec.max}, not ${text}.`)
  return n
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`The ${spec.label} field has an empty item in its list.`)
    const pieces = part.split('/')
    if (pieces.length > 2) throw new CronError(`The ${spec.label} field has more than one step in "${part}".`)
    const [range, stepText] = pieces
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`The step in "${part}" must be a whole number above 0.`)
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (range === '*') {
      from = spec.min
      to = spec.max
    } else if (range.includes('-')) {
      const ends = range.split('-')
      if (ends.length !== 2) throw new CronError(`The ${spec.label} field has a bad range: "${range}".`)
      from = value(ends[0], spec)
      // Sunday can end a week as well as start one, as in mon-sun.
      to = spec.names === WEEKDAYS && ends[1].toLowerCase() === 'sun' ? 7 : value(ends[1], spec)
      if (from > to) throw new CronError(`The range "${range}" in the ${spec.label} field runs backward.`)
    } else {
      from = value(range, spec)
      // A start with a step and no end runs to the top of the field.
      to = stepText !== undefined ? spec.max : from
    }
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return out
}

export function parseCron(expr: string): CronResult {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5 || !parts[0]) {
    return { ok: false, error: `Cron needs 5 fields (minute, hour, day of month, month, day of week). This has ${parts[0] ? parts.length : 0}.` }
  }
  try {
    const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]))
    // 7 is another way to write Sunday.
    if (weekdays.delete(7)) weekdays.add(0)
    return {
      ok: true,
      cron: { minutes, hours, days, months, weekdays, dayRestricted: !parts[2].startsWith('*'), weekdayRestricted: !parts[4].startsWith('*') }
    }
  } catch (e) {
    if (e instanceof CronError) return { ok: false, error: e.message }
    throw e
  }
}

function dayMatches(cron: Cron, d: Date): boolean {
  const day = cron.days.has(d.getDate())
  const weekday = cron.weekdays.has(d.getDay())
  return cron.dayRestricted && cron.weekdayRestricted ? day || weekday : day && weekday
}

/** A leap day can be 8 years away, across a century that skips one. */
const HORIZON_YEARS = 9

/** The first matching minute strictly after this time, or null if it can never match, as with 30 February. */
export function nextCron(cron: Cron, after: number): number | null {
  const start = new Date(after)
  start.setSeconds(0, 0)
  let d = new Date(start.getTime() + 60_000)
  const lastYear = d.getFullYear() + HORIZON_YEARS
  while (d.getFullYear() <= lastYear) {
    const [y, mo, day, h] = [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]
    if (!cron.months.has(mo + 1)) d = new Date(y, mo + 1, 1)
    else if (!dayMatches(cron, d)) d = new Date(y, mo, day + 1)
    else if (!cron.hours.has(h)) d = new Date(y, mo, day, h + 1)
    else if (!cron.minutes.has(d.getMinutes())) d = new Date(d.getTime() + 60_000)
    else return d.getTime()
  }
  return null
}
