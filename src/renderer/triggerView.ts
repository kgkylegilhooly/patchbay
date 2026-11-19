import { isArmed } from '../core/trigger/arming'
import { describeInterval, MIN_INTERVAL_MS } from '../core/trigger/schedule'
import { DEFAULT_LIMITS, DEFAULT_QUIET_MS, isEventSchedule, preflightArgv, preflightText } from '../core/trigger/events'
import type { TriggerLimits, TriggerNode, TriggerOutcome, TriggerPreflight, TriggerSchedule } from '../shared/model'

export type TriggerState = 'armed' | 'disarmed' | 'done'

export function triggerState(node: TriggerNode): TriggerState {
  if (isArmed(node)) return 'armed'
  return node.schedule.type === 'once' && node.runs.some((r) => r.source === 'schedule') ? 'done' : 'disarmed'
}

export const STATE_LABELS: Record<TriggerState, string> = { armed: 'Armed', disarmed: 'Not armed', done: 'Done' }

export const OUTCOME_LABELS: Record<TriggerOutcome, string> = {
  delivered: 'Delivered',
  queued: 'Waiting',
  missed: 'Missed',
  failed: 'Failed',
  skipped: 'Skipped'
}

/** "in 4 s", "in 12 min", "in 3 h", for how soon the next run is. */
export function relative(ms: number): string {
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `in ${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`
  if (ms < 2 * 86_400_000) return `in ${Math.round(ms / 3_600_000)} h`
  return `in ${Math.round(ms / 86_400_000)} days`
}

export function nextLabel(node: TriggerNode, now: number): string {
  if (isEventSchedule(node.schedule)) return isArmed(node) ? 'Whenever it happens.' : 'Arm it to listen for it.'
  if (!isArmed(node)) return 'Arm it to schedule it.'
  if (node.nextAt === null) return 'No more runs.'
  return `${new Date(node.nextAt).toLocaleString()} (${relative(node.nextAt - now)})`
}

export type IntervalUnit = 'seconds' | 'minutes' | 'hours'
export const UNIT_MS: Record<IntervalUnit, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000 }

/** The largest unit that divides it, for showing a saved interval in the form. */
export function intervalParts(ms: number): { amount: number; unit: IntervalUnit } {
  for (const unit of ['hours', 'minutes'] as const) if (ms % UNIT_MS[unit] === 0) return { amount: ms / UNIT_MS[unit], unit }
  return { amount: Math.round(ms / 1000), unit: 'seconds' }
}

/** A datetime-local value, which is in local time with no zone. */
export function toLocalInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN
}

export interface ScheduleDraft {
  type: TriggerSchedule['type']
  amount: string
  unit: IntervalUnit
  expr: string
  at: string
  /** Event kinds. */
  agentId: string
  agentOn: 'turn' | 'needs-you' | 'exit'
  runId: string
  failedOnly: boolean
  folder: string
  glob: string
  quietSeconds: string
}

export function draftOf(s: TriggerSchedule, now: number, folder = ''): ScheduleDraft {
  const base: ScheduleDraft = { type: s.type, amount: '5', unit: 'minutes', expr: '0 9 * * 1-5', at: toLocalInput(now + 3_600_000), agentId: '', agentOn: 'turn', runId: '', failedOnly: true, folder, glob: '**/*', quietSeconds: String(DEFAULT_QUIET_MS / 1000) }
  if (s.type === 'interval') {
    const { amount, unit } = intervalParts(s.everyMs)
    return { ...base, amount: String(amount), unit }
  }
  if (s.type === 'cron') return { ...base, expr: s.expr }
  if (s.type === 'once') return { ...base, at: toLocalInput(s.at) }
  if (s.type === 'agent') return { ...base, agentId: s.nodeId, agentOn: s.on }
  if (s.type === 'run') return { ...base, runId: s.nodeId, failedOnly: s.failedOnly }
  return { ...base, folder: s.folder, glob: s.glob, quietSeconds: String(s.quietMs / 1000) }
}

export function scheduleOf(d: ScheduleDraft): TriggerSchedule {
  if (d.type === 'cron') return { type: 'cron', expr: d.expr.trim() }
  if (d.type === 'once') return { type: 'once', at: fromLocalInput(d.at) }
  if (d.type === 'agent') return { type: 'agent', nodeId: d.agentId, on: d.agentOn }
  if (d.type === 'run') return { type: 'run', nodeId: d.runId, failedOnly: d.failedOnly }
  if (d.type === 'files') return { type: 'files', folder: d.folder.trim(), glob: d.glob.trim(), quietMs: secondsOf(d.quietSeconds) }
  const amount = Number(d.amount)
  return { type: 'interval', everyMs: Number.isFinite(amount) && d.amount.trim() ? Math.round(amount * UNIT_MS[d.unit]) : NaN }
}

export { describeInterval, MIN_INTERVAL_MS }

const secondsOf = (text: string): number => {
  const n = Number(text)
  return text.trim() && Number.isFinite(n) ? Math.round(n * 1000) : NaN
}

/** The rest of what arming agrees to: a check before firing, and an event's limits. */
export interface ExtrasDraft {
  command: string
  cwd: string
  gapSeconds: string
  perHour: string
}

export function extrasDraftOf(node: Pick<TriggerNode, 'preflight' | 'limits'> | undefined, folder: string): ExtrasDraft {
  const limits = node?.limits ?? DEFAULT_LIMITS
  return { command: preflightText(node?.preflight), cwd: node?.preflight?.cwd ?? folder, gapSeconds: String(limits.gapMs / 1000), perHour: String(limits.perHour) }
}

export function extrasOf(d: ExtrasDraft, s: TriggerSchedule): { preflight: TriggerPreflight | null; limits: TriggerLimits | undefined; problem: string | null } {
  const parsed = preflightArgv(d.command)
  const preflight = parsed.ok && parsed.argv ? { argv: parsed.argv, cwd: d.cwd.trim() } : null
  const limits = isEventSchedule(s) ? { gapMs: secondsOf(d.gapSeconds), perHour: Number(d.perHour) } : undefined
  return { preflight, limits, problem: parsed.ok ? null : parsed.reason }
}
