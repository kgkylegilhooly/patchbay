import { createHash, randomUUID } from 'node:crypto'
import type { PendingApproval } from '../../shared/contract'

export type ApprovalDecision = 'allow' | 'deny'
/** What the person can answer. `allow-always` also applies the rule Claude itself offered for "don't ask again". */
export type ApprovalChoice = ApprovalDecision | 'allow-always'

/** Never the person's own settings or the project's shared file: only what stays with this project and person, or this session. */
type AlwaysWhere = 'localSettings' | 'session'

/** One of Claude's own permission updates, as a PermissionRequest hook receives and may echo back. Only rule additions that allow. */
export interface AllowRuleUpdate {
  type: 'addRules'
  rules: Array<{ toolName: string; ruleContent?: string }>
  behavior: 'allow'
  destination: AlwaysWhere
}

export interface ApprovalAnswer {
  decision: ApprovalDecision
  /** Applied by Claude with the allow. See https://code.claude.com/docs/en/hooks, PermissionRequest. */
  updatedPermissions?: AllowRuleUpdate[]
}

export interface Approvals {
  /** Resolves with the answer, or null when the terminal prompt should decide instead. */
  request(
    nodeId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ApprovalAnswer | null>
  /**
   * Only the renderer's answerApproval IPC may call this. No agent-reachable path may. `allow-always` applies the rule
   * kept from the request, never one sent with the answer, and does nothing for a request that offered none.
   */
  answer(requestId: string, choice: ApprovalChoice): void
  clearNode(nodeId: string): void
  pending(): PendingApproval[]
  onChange(cb: (pending: PendingApproval[]) => void): void
}

/** Answering these takes more than allow or deny, so they stay in the terminal. */
const TERMINAL_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode'])
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'prompt', 'description']
const SUMMARY_MAX = 199
/** Far more than a command anyone would read through, and small enough to send to the page on every change. */
const DETAIL_MAX = 4000

const cut = (line: string, max: number): string => (line.length <= max ? line : line.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '') + '…')

function describe(input: Record<string, unknown>): Pick<PendingApproval, 'summary' | 'detail'> {
  const field = SUMMARY_FIELDS.map((k) => input[k]).find((v) => typeof v === 'string' && v)
  // Collapsing runs of whitespace stops padding from pushing the dangerous part out of view.
  const line = ((field as string | undefined) ?? JSON.stringify(input)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
  return { summary: cut(line, SUMMARY_MAX), detail: cut(line, DETAIL_MAX) }
}

/** JSON with every object's keys in order, so the same input always reads the same, whatever order it came in. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** One value for the whole request: the tool and every field of its input, nothing cut or squeezed. */
export const requestKey = (tool: string, input: unknown): string => createHash('sha256').update(`${tool}\0${stableJson(input)}`).digest('hex').slice(0, 32)

const WHERE: Record<AlwaysWhere, string> = { localSettings: 'in this project', session: 'for the rest of this session' }
const MAX_RULES = 10

/** A copy of a suggestion holding only the fields Claude documents, or null for anything else. */
function allowRule(s: unknown): AllowRuleUpdate | null {
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  if (o.type !== 'addRules' || o.behavior !== 'allow' || (o.destination !== 'localSettings' && o.destination !== 'session')) return null
  if (!Array.isArray(o.rules) || o.rules.length === 0 || o.rules.length > MAX_RULES) return null
  const rules: AllowRuleUpdate['rules'] = []
  for (const r of o.rules as unknown[]) {
    const rule = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    if (typeof rule.toolName !== 'string' || !rule.toolName) return null
    if (rule.ruleContent !== undefined && typeof rule.ruleContent !== 'string') return null
    rules.push({ toolName: rule.toolName, ...(typeof rule.ruleContent === 'string' && { ruleContent: rule.ruleContent }) })
  }
  return { type: 'addRules', rules, behavior: 'allow', destination: o.destination }
}

/** The rule Claude offers for "don't ask again": one kept to this project first, else this session. */
function alwaysRule(suggestions: unknown): AllowRuleUpdate | null {
  const usable = (Array.isArray(suggestions) ? suggestions : []).map(allowRule).filter((r): r is AllowRuleUpdate => r !== null)
  return usable.find((r) => r.destination === 'localSettings') ?? usable[0] ?? null
}

/** As Claude writes rules in its settings: Bash(npm test), or the bare tool name for the whole tool. */
const ruleText = (u: AllowRuleUpdate): string =>
  cut(
    u.rules
      .map((r) => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`))
      .join(', ')
      .replace(/[\s\x00-\x1f\x7f]+/g, ' '),
    SUMMARY_MAX
  )

interface Entry {
  approval: PendingApproval
  rule: AllowRuleUpdate | null
  settle(answer: ApprovalAnswer | null): void
}

export function createApprovals({ holdMs = 540000 }: { holdMs?: number } = {}): Approvals {
  const entries = new Map<string, Entry>()
  const listeners: Array<(pending: PendingApproval[]) => void> = []

  const pending = (): PendingApproval[] => [...entries.values()].map((e) => e.approval)
  const changed = (): void => {
    const list = pending()
    for (const cb of listeners) cb(list)
  }

  return {
    pending,
    onChange(cb) {
      listeners.push(cb)
    },

    request(nodeId, payload, signal) {
      const tool = payload.tool_name
      const input = payload.tool_input
      if (typeof tool !== 'string' || typeof input !== 'object' || input === null || TERMINAL_ONLY.has(tool)) {
        return Promise.resolve(null)
      }
      if (signal?.aborted) return Promise.resolve(null)

      return new Promise((resolve) => {
        const requestId = randomUUID()
        const timer = setTimeout(() => settle(null), holdMs)
        timer.unref?.()
        const onAbort = (): void => settle(null)
        function settle(answer: ApprovalAnswer | null): void {
          if (!entries.delete(requestId)) return
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(answer)
          changed()
        }
        signal?.addEventListener('abort', onAbort)
        const rule = alwaysRule(payload.permission_suggestions)
        const always = rule && { always: { rule: ruleText(rule), where: WHERE[rule.destination] } }
        entries.set(requestId, {
          approval: { nodeId, requestId, tool, ...describe(input as Record<string, unknown>), same: requestKey(tool, input), ...always },
          rule,
          settle
        })
        changed()
      })
    },

    answer(requestId, choice) {
      const entry = entries.get(requestId)
      if (!entry) return
      if (choice === 'allow' || choice === 'deny') entry.settle({ decision: choice })
      else if (choice === 'allow-always' && entry.rule) entry.settle({ decision: 'allow', updatedPermissions: [entry.rule] })
    },

    clearNode(nodeId) {
      for (const entry of [...entries.values()]) {
        if (entry.approval.nodeId === nodeId) entry.settle(null)
      }
    }
  }
}
