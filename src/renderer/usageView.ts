import type { AgentAccount, BudgetState, CodexUsage, NodeUsage, PlanUsage, UsageState, UsageWindow } from '../shared/usage'

export type UsageLevel = 'ok' | 'warn' | 'high'

export type UsageMode = 'used' | 'left'

export interface LimitRow {
  label: string
  percentText: string
  barPercent: number
  level: UsageLevel
  resets: string
}

export interface PillView {
  text: string
  level: UsageLevel
  stale: boolean
  detail: string
  /** How full the mini bar is. It shows the same quantity as the numbers beside it. */
  barPercent: number
  /** Claude's limits. */
  rows: LimitRow[]
  updated: string
  claudeAccount?: AccountView
  /** Absent when Codex isn't installed or hasn't answered yet. */
  codex?: { rows: LimitRow[]; account?: AccountView; problem: string | null; updated: string }
}

export interface AccountView {
  email: string
  detail: string
}

/** Used above these. The color always follows real use, whichever way the numbers are shown. */
const WARN_ABOVE = 60
const HIGH_ABOVE = 80
/** Limits only update while a session is responding, so older than this may be well out of date. */
const STALE_AFTER_MS = 15 * 60_000

const TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

const levelOf = (percent: number): UsageLevel => (percent > HIGH_ABOVE ? 'high' : percent > WARN_ABOVE ? 'warn' : 'ok')

const shown = (percent: number, mode: UsageMode): number => Math.round(mode === 'left' ? 100 - percent : percent)

function updatedText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'Updated just now'
  return minutes < 60 ? `Updated ${minutes}m ago` : `Updated ${Math.floor(minutes / 60)}h ago`
}

function resetsIn(resetsAt: number, now: number): string {
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60_000)
  if (minutes < 60) return `Resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `Resets in ${hours}h ${minutes % 60}m` : `Resets in ${hours}h`
  return hours % 24 ? `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h` : `Resets in ${Math.floor(hours / 24)}d`
}

function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 120) return `${minutes} minutes ago`
  return `${Math.round(minutes / 60)} hours ago`
}

export function amount(n: number): string {
  if (n < 100 && !Number.isInteger(n)) return n.toFixed(2)
  return Math.round(n).toLocaleString('en-US')
}

function liveWindows(plan: PlanUsage | null, now: number): { fiveHour?: UsageWindow; sevenDay?: UsageWindow } {
  const live = (w?: UsageWindow): UsageWindow | undefined => (w && w.resetsAt * 1000 > now ? w : undefined)
  return { fiveHour: live(plan?.fiveHour), sevenDay: live(plan?.sevenDay) }
}

function planLines(plan: PlanUsage | null, now: number): string[] {
  const { fiveHour, sevenDay } = liveWindows(plan, now)
  const line = (name: string, w: UsageWindow): string => `${name}: ${w.percent}%, resets ${TIME.format(w.resetsAt * 1000)}`
  const lines = [...(fiveHour ? [line('5-hour limit', fiveHour)] : []), ...(sevenDay ? [line('Weekly limit', sevenDay)] : [])]
  return lines.length && plan ? [...lines, `Claude reported this ${ago(plan.at, now)}.`] : []
}

function budgetPill(budget: BudgetState, plan: PlanUsage | null, now: number): PillView {
  const unread = budget.used < 0 || budget.limit < 0
  const percent = budget.limit > 0 ? (budget.used / budget.limit) * 100 : budget.used > 0 ? 100 : 0
  const text = unread
    ? 'Usage unavailable'
    : `${budget.unit}${amount(budget.used)} of ${budget.unit}${amount(budget.limit)}${budget.period ? ` ${budget.period}` : ''}`
  const lines = [
    ...(budget.problem ? [budget.problem] : []),
    ...(unread ? [] : [`Read ${ago(budget.at, now)}.`]),
    ...planLines(plan, now)
  ]
  return { text, level: unread ? 'ok' : levelOf(percent), stale: !!budget.problem, detail: lines.join('\n'), barPercent: unread ? 0 : Math.min(100, percent), rows: [], updated: updatedText(budget.at, now) }
}

function accountView(account: AgentAccount | null | undefined): AccountView | undefined {
  if (!account?.email) return undefined
  const plan = account.plan ? `${account.plan[0].toUpperCase()}${account.plan.slice(1)} plan` : ''
  return { email: account.email, detail: [plan, account.organization ? `Organization: ${account.organization}` : ''].filter(Boolean).join(' · ') }
}

/** Codex says each window's length, which can be hours, a week or a month. */
export function codexWindowLabel(minutes: number): string {
  if (minutes === 300) return '5-hour limit'
  if (minutes === 7 * 24 * 60) return 'Weekly limit'
  if (minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60) return 'Monthly limit'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day limit`
  return minutes % 60 === 0 ? `${minutes / 60}-hour limit` : `${minutes}-minute limit`
}

function limitRow(label: string, w: UsageWindow, now: number, mode: UsageMode): LimitRow {
  return { label, percentText: `${shown(w.percent, mode)}% ${mode}`, barPercent: shown(w.percent, mode), level: levelOf(w.percent), resets: resetsIn(w.resetsAt, now) }
}

function codexView(codex: CodexUsage | null | undefined, now: number, mode: UsageMode): PillView['codex'] {
  if (!codex) return undefined
  const live = codex.windows.filter((w) => w.resetsAt * 1000 > now)
  if (!live.length && !codex.problem) return undefined
  return {
    rows: live.map((w) => limitRow(codexWindowLabel(w.minutes), w, now, mode)),
    account: accountView(codex.account),
    problem: codex.problem,
    updated: updatedText(codex.at, now)
  }
}

/** What the title bar shows: a configured budget if there is one, otherwise Claude's plan limits and Codex's. */
export function pillText(state: UsageState, now: number, mode: UsageMode = 'used'): PillView | null {
  if (state.off) return null
  if (state.budget) return budgetPill(state.budget, state.plan, now)
  const { fiveHour, sevenDay } = liveWindows(state.plan, now)
  const claude = !!state.plan && (!!fiveHour || !!sevenDay)
  const codex = codexView(state.codex, now, mode)
  const codexLive = (state.codex?.windows ?? []).filter((w) => w.resetsAt * 1000 > now)
  if (!claude && !codexLive.length) return null
  // Codex's part shows its closest limit, the one that would stop it first.
  const codexClosest = codexLive.length ? Math.max(...codexLive.map((w) => w.percent)) : undefined
  const parts = [
    ...(fiveHour ? [`5h ${shown(fiveHour.percent, mode)}%`] : []),
    ...(sevenDay ? [`wk ${shown(sevenDay.percent, mode)}%`] : []),
    ...(codexClosest !== undefined ? [`Codex ${shown(codexClosest, mode)}%`] : [])
  ]
  const closest = Math.max(fiveHour?.percent ?? 0, sevenDay?.percent ?? 0, codexClosest ?? 0)
  const at = Math.max(state.plan?.at ?? 0, state.codex?.at ?? 0)
  return {
    // The mode word once, at the end, says whether the numbers are what is used or what is left.
    text: `${parts.join(' · ')} ${mode}`,
    level: levelOf(closest),
    stale: now - at > STALE_AFTER_MS,
    detail: planLines(state.plan, now).join('\n'),
    barPercent: shown(closest, mode),
    rows: [...(fiveHour ? [limitRow('5-hour limit', fiveHour, now, mode)] : []), ...(sevenDay ? [limitRow('Weekly limit', sevenDay, now, mode)] : [])],
    updated: updatedText(at, now),
    ...(accountView(state.claudeAccount) ? { claudeAccount: accountView(state.claudeAccount) } : {}),
    ...(codex ? { codex } : {})
  }
}

export function contextLabel(usage: NodeUsage | undefined): { text: string; level: UsageLevel; detail: string } | null {
  if (usage?.contextPercent === undefined) return null
  const lines = [
    ...(usage.tokens === undefined ? [] : [`${usage.tokens.toLocaleString('en-US')} tokens this session`]),
    ...(usage.costUsd === undefined ? [] : [`About $${usage.costUsd.toFixed(2)} at API prices`])
  ]
  return { text: `${Math.round(usage.contextPercent)}% context`, level: levelOf(usage.contextPercent), detail: lines.join('\n') }
}
