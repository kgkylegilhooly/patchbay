import { randomUUID } from 'node:crypto'
import type { PendingApproval } from '../../shared/contract'

export type ApprovalDecision = 'allow' | 'deny'

export interface Approvals {
  /** Resolves with the answer, or null when the terminal prompt should decide instead. */
  request(
    nodeId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ApprovalDecision | null>
  /** Only the renderer's answerApproval IPC may call this. No agent-reachable path may. */
  answer(requestId: string, decision: ApprovalDecision): void
  clearNode(nodeId: string): void
  pending(): PendingApproval[]
  onChange(cb: (pending: PendingApproval[]) => void): void
}

/** Answering these takes more than allow or deny, so they stay in the terminal. */
const TERMINAL_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode'])
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'prompt', 'description']
const SUMMARY_MAX = 199

function summarize(input: Record<string, unknown>): string {
  const field = SUMMARY_FIELDS.map((k) => input[k]).find((v) => typeof v === 'string' && v)
  // Collapsing runs of whitespace stops padding from pushing the dangerous part out of view.
  const line = ((field as string | undefined) ?? JSON.stringify(input)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
  if (line.length <= SUMMARY_MAX) return line
  return line.slice(0, SUMMARY_MAX - 1).replace(/[\ud800-\udbff]$/, '') + '…'
}

interface Entry {
  approval: PendingApproval
  settle(decision: ApprovalDecision | null): void
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
        function settle(decision: ApprovalDecision | null): void {
          if (!entries.delete(requestId)) return
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(decision)
          changed()
        }
        signal?.addEventListener('abort', onAbort)
        entries.set(requestId, {
          approval: { nodeId, requestId, tool, summary: summarize(input as Record<string, unknown>) },
          settle
        })
        changed()
      })
    },

    answer(requestId, decision) {
      if (decision !== 'allow' && decision !== 'deny') return
      entries.get(requestId)?.settle(decision)
    },

    clearNode(nodeId) {
      for (const entry of [...entries.values()]) {
        if (entry.approval.nodeId === nodeId) entry.settle(null)
      }
    }
  }
}
