import type { TriggerNode, TriggerSchedule } from '../../shared/model'

/**
 * When a trigger may fire: from `startsAt`, up to and including `endsAt`. Either may be absent, and absent means no
 * limit, so a trigger saved before these existed fires exactly as it did. A one-off has its own time, so no window
 * applies to it.
 */
export type TriggerWindow = Partial<Pick<TriggerNode, 'startsAt' | 'endsAt'>>

export interface Window {
  start: number | null
  end: number | null
}

/** The window that applies to this trigger, or null if none does. */
export function windowOf(node: { schedule: TriggerSchedule } & TriggerWindow): Window | null {
  if (node.schedule.type === 'once') return null
  const start = node.startsAt ?? null
  const end = node.endsAt ?? null
  return start === null && end === null ? null : { start, end }
}

/** Whether something at this time is inside the window. No window lets everything through. */
export function inWindow(w: Window | null, at: number): boolean {
  return !w || ((w.start === null || at >= w.start) && (w.end === null || at <= w.end))
}

/** What's wrong with the window as written, or null. An end that has passed is judged when arming, as a one-off is. */
export function windowError(node: { schedule: TriggerSchedule } & TriggerWindow): string | null {
  const w = windowOf(node)
  if (!w) return null
  if (w.start !== null && !Number.isFinite(w.start)) return 'Give the start as a date and time, or leave it empty.'
  if (w.end !== null && !Number.isFinite(w.end)) return 'Give the end as a date and time, or leave it empty.'
  if (w.start !== null && w.end !== null && w.end <= w.start) return 'The end must be after the start.'
  return null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "21 Nov 14:00" in local time, with the year when it isn't this year. */
export function describeWhen(at: number, now = Date.now()): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ", from 21 Nov 14:00 until 22 Nov 09:00", or "" with no window, to follow a schedule's description. */
export function describeWindow(w: Window | null, now = Date.now()): string {
  if (!w) return ''
  const from = w.start !== null && Number.isFinite(w.start) ? ` from ${describeWhen(w.start, now)}` : ''
  const until = w.end !== null && Number.isFinite(w.end) ? ` until ${describeWhen(w.end, now)}` : ''
  return from || until ? `,${from}${until}` : ''
}
