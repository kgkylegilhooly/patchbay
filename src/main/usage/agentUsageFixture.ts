import { readFileSync } from 'node:fs'
import type { AgentAccount, CodexUsage, CodexWindow } from '../../shared/usage'
import type { UsageService } from './usageService'

/**
 * Screenshot scenes and acceptance runs open the app in a throwaway profile, but the agent accounts and Codex's limits
 * came from asking the person's own `claude` and `codex`, so pictures showed their real email and real Codex usage.
 * With PATCHBAY_AGENT_USAGE naming a file, those come from that file instead, and neither program is ever started:
 *
 *   { "claudeAccount": { "email": "…", "plan": "max" },
 *     "codex": { "account": { … }, "windows": [{ "percent": 23, "minutes": 300, "resetsInMinutes": 90 }] } }
 *
 * `resetsInMinutes` counts from when it's read, so a saved file never runs out. A missing or broken file means no
 * account and no Codex limits, still without asking anything.
 *
 * It's honoured by the packaged app too, deliberately: acceptance runs against a packaged build need it. It only
 * changes what the usage pill shows, and only when someone sets the variable.
 */
export const AGENT_USAGE_ENV = 'PATCHBAY_AGENT_USAGE'

type Fields = Record<string, unknown>
const fields = (v: unknown): Fields => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function account(v: unknown): AgentAccount | null {
  const a = fields(v)
  const out: AgentAccount = {}
  for (const key of ['email', 'organization', 'plan'] as const) if (typeof a[key] === 'string') out[key] = a[key] as string
  return Object.keys(out).length ? out : null
}

function codexUsage(v: unknown, now: number): CodexUsage | null {
  if (typeof v !== 'object' || v === null) return null
  const c = fields(v)
  const windows: CodexWindow[] = []
  for (const raw of Array.isArray(c.windows) ? c.windows : []) {
    const w = fields(raw)
    const percent = num(w.percent)
    const minutes = num(w.minutes)
    const resetsIn = num(w.resetsInMinutes)
    if (percent === undefined || minutes === undefined || resetsIn === undefined) continue
    windows.push({ percent, minutes, resetsAt: now / 1000 + resetsIn * 60 })
  }
  return { account: account(c.account), windows: windows.sort((a, b) => a.minutes - b.minutes), at: now, problem: null }
}

/** True when the variable is set, and the made-up numbers were shown: the programs mustn't be asked then. */
export function applyAgentUsageFixture(
  env: NodeJS.ProcessEnv,
  usage: Pick<UsageService, 'setClaudeAccount' | 'setCodex'>,
  now = Date.now()
): boolean {
  const file = env[AGENT_USAGE_ENV]
  if (!file) return false
  let saved: Fields = {}
  try {
    saved = fields(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // Nothing to show, which is still nothing real.
  }
  usage.setClaudeAccount(account(saved.claudeAccount))
  const codex = codexUsage(saved.codex, now)
  if (codex) usage.setCodex(codex)
  return true
}
