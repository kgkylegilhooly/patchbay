import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../../core/persist/atomicFile'
import type { AgentAccount, BudgetState, CodexUsage, NodeUsage, PlanUsage, UsageReport, UsageState, UsageWindow } from '../../shared/usage'

const SAVE_DELAY_MS = 2000
/** How stale "updated" may get while the limits stay the same. */
const PLAN_FRESH_MS = 60_000

export interface UsageService {
  report(nodeId: string, report: UsageReport): void
  forget(nodeId: string): void
  state(): UsageState
  onChange(cb: () => void): void
  setBudget(budget: BudgetState | null): void
  setOff(off: boolean): void
  setClaudeAccount(account: AgentAccount | null): void
  /** A failed read keeps the last good windows and says why. */
  setCodex(codex: CodexUsage | { problem: string; at: number }): void
  flush(): Promise<void>
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isWindow = (v: unknown): v is UsageWindow => {
  const w = v as UsageWindow | null | undefined
  return !!w && isNumber(w.percent) && isNumber(w.resetsAt)
}

function loadPlan(v: unknown): PlanUsage | null {
  const p = v as PlanUsage | null | undefined
  if (!p || !isNumber(p.at) || (p.fiveHour !== undefined && !isWindow(p.fiveHour)) || (p.sevenDay !== undefined && !isWindow(p.sevenDay))) return null
  return p
}

function loadBudget(v: unknown): BudgetState | null {
  const b = v as BudgetState | null | undefined
  if (!b || !isNumber(b.used) || !isNumber(b.limit) || !isNumber(b.at) || typeof b.unit !== 'string' || typeof b.period !== 'string') return null
  return { ...b, problem: typeof b.problem === 'string' ? b.problem : null }
}

function load(file: string): { plan: PlanUsage | null; budget: BudgetState | null } {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { plan: loadPlan(saved?.plan), budget: loadBudget(saved?.budget) }
  } catch {
    return { plan: null, budget: null }
  }
}

/** The latest numbers. Limits and the budget are saved, so the pill has something to show after a restart. */
export function createUsageService({ dataDir, now = Date.now }: { dataDir: string; now?: () => number }): UsageService {
  const file = join(dataDir, 'usage.json')
  const saved = load(file)
  let plan = saved.plan
  let budget = saved.budget
  let off = false
  let claudeAccount: AgentAccount | null = null
  let codex: CodexUsage | null = null
  const nodes = new Map<string, NodeUsage>()
  const listeners: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  const write = (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    const text = JSON.stringify({ plan, budget })
    writing = writing.then(() => writeAtomic(file, text)).catch((e: unknown) => console.error('Patchbay could not save its usage numbers:', e))
    return writing
  }
  const changed = (): void => {
    timer ??= setTimeout(() => void write(), SAVE_DELAY_MS)
    timer.unref?.()
    for (const cb of listeners) cb()
  }

  /** Claude stops reporting a window once it has reset, so an old number must not linger. */
  const current = (): PlanUsage | null => {
    if (!plan) return null
    const live = (w: UsageWindow | undefined): UsageWindow | undefined => (w && w.resetsAt * 1000 > now() ? w : undefined)
    const fiveHour = live(plan.fiveHour)
    const sevenDay = live(plan.sevenDay)
    if (!fiveHour && !sevenDay) return null
    return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: plan.at }
  }

  /** A window past its reset no longer says anything. */
  const liveCodex = (): CodexUsage | null => (codex ? { ...codex, windows: codex.windows.filter((w) => w.resetsAt * 1000 > now()) } : null)

  return {
    report(nodeId, report) {
      const { fiveHour, sevenDay, sessionId: _sessionId, contextSize: _contextSize, ...own } = report
      const before = JSON.stringify([nodes.get(nodeId), plan])
      if (Object.keys(own).length) nodes.set(nodeId, { ...nodes.get(nodeId), ...own })
      if (fiveHour || sevenDay) {
        const next = { ...plan, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
        // Every status line carries the limits, mostly unchanged. Only new numbers, or a minute passing, count as a
        // change: stamping each one rewrote usage.json every two seconds while agents worked.
        const same = plan && JSON.stringify([next.fiveHour, next.sevenDay]) === JSON.stringify([plan.fiveHour, plan.sevenDay])
        if (!same || now() - (plan?.at ?? 0) >= PLAN_FRESH_MS) plan = { ...next, at: now() }
      }
      if (JSON.stringify([nodes.get(nodeId), plan]) !== before) changed()
    },
    forget(nodeId) {
      if (nodes.delete(nodeId)) for (const cb of listeners) cb()
    },
    state: () => ({ plan: current(), nodes: Object.fromEntries(nodes), budget, ...(claudeAccount ? { claudeAccount } : {}), ...(codex ? { codex: liveCodex() } : {}), ...(off ? { off: true as const } : {}) }),
    setClaudeAccount(next) {
      if (JSON.stringify(next) === JSON.stringify(claudeAccount)) return
      claudeAccount = next
      for (const cb of listeners) cb()
    },
    setCodex(next) {
      const merged: CodexUsage = 'windows' in next ? next : { windows: codex?.windows ?? [], account: codex?.account ?? null, at: codex?.at ?? next.at, problem: next.problem }
      if (JSON.stringify(merged) === JSON.stringify(codex)) return
      codex = merged
      for (const cb of listeners) cb()
    },
    setOff(next) {
      if (next === off) return
      off = next
      for (const cb of listeners) cb()
    },
    onChange(cb) {
      listeners.push(cb)
    },
    setBudget(next) {
      if (JSON.stringify(next) === JSON.stringify(budget)) return
      budget = next
      changed()
    },
    flush: write
  }
}
