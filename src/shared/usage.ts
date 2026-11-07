export interface UsageWindow {
  percent: number
  /** Unix seconds. */
  resetsAt: number
}

/** What one Claude session's status line reported. Any field can be missing. */
export interface UsageReport {
  sessionId?: string
  costUsd?: number
  contextPercent?: number
  contextSize?: number
  tokens?: number
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
}

type Fields = Record<string, unknown>

const fields = (v: unknown): Fields => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function usageWindow(v: unknown): UsageWindow | undefined {
  const { used_percentage: percent, resets_at: resetsAt } = fields(v)
  const p = num(percent)
  const r = num(resetsAt)
  return p === undefined || r === undefined ? undefined : { percent: p, resetsAt: r }
}

/** Takes what Claude passes a status line. Anything malformed is left out, field by field. */
export function parseUsageReport(raw: unknown): UsageReport {
  const top = fields(raw)
  const context = fields(top.context_window)
  const limits = fields(top.rate_limits)
  const input = num(context.total_input_tokens)
  const output = num(context.total_output_tokens)
  const candidates: UsageReport = {
    sessionId: typeof top.session_id === 'string' ? top.session_id : undefined,
    costUsd: num(fields(top.cost).total_cost_usd),
    contextPercent: num(context.used_percentage),
    contextSize: num(context.context_window_size),
    tokens: input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0),
    fiveHour: usageWindow(limits.five_hour),
    sevenDay: usageWindow(limits.seven_day)
  }
  return Object.fromEntries(Object.entries(candidates).filter(([, v]) => v !== undefined)) as UsageReport
}

export type NodeUsage = Pick<UsageReport, 'contextPercent' | 'tokens' | 'costUsd'>

export interface PlanUsage {
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  /** When Claude last reported limits. */
  at: number
}

/** A spending budget read from a configured source. Negative amounts mean none has been read yet. */
export interface BudgetState {
  used: number
  limit: number
  unit: string
  period: string
  at: number
  /** Why the last read failed. The amounts are then the last good ones. */
  problem: string | null
}

/** Who an agent program is signed in as. */
export interface AgentAccount {
  email?: string
  organization?: string
  /** Such as pro, max or free. */
  plan?: string
}

/** A Codex limit. Codex says how long each window is, which can be hours or a whole month. */
export interface CodexWindow extends UsageWindow {
  minutes: number
}

/** What Codex's app server last said about its limits and account. */
export interface CodexUsage {
  windows: CodexWindow[]
  account: AgentAccount | null
  at: number
  /** Why the last read failed. The windows are then the last good ones. */
  problem: string | null
}

export interface UsageState {
  plan: PlanUsage | null
  nodes: Record<string, NodeUsage>
  budget: BudgetState | null
  claudeAccount?: AgentAccount | null
  codex?: CodexUsage | null
  /** The owner turned the pill off. */
  off?: true
}
