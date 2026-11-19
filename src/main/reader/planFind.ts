import { open } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { parseLine } from '../../core/transcript/read'
import { isDocPath } from '../../shared/reader'

/** What "Open plan" found in a conversation. */
export type FoundPlan =
  /** A plan file Claude Code's plan mode wrote, which the reader can follow as it changes. */
  | { kind: 'file'; path: string; what: 'plan file' }
  /** Text from the transcript only: a plan with no file, or a long answer. */
  | { kind: 'text'; text: string; what: 'plan' | 'answer' }

/** An answer long enough to be worth reading in a reader rather than in the terminal. */
export function isLongMarkdown(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim()).length
  return text.length >= 800 || (lines >= 12 && /^#{1,6}\s/m.test(text))
}

/** Where Claude Code's plan mode writes plans: ~/.claude/plans. Verified against its ExitPlanMode tool calls. */
export function plansFolder(home: string): string {
  return join(home, '.claude', 'plans')
}

function inFolder(path: string, folder: string): boolean {
  const p = normalize(path).toLowerCase()
  const f = normalize(folder).toLowerCase().replace(/[\\/]+$/, '')
  return p.startsWith(`${f}\\`) || p.startsWith(`${f}/`)
}

type Block = { type?: string; name?: string; input?: Record<string, unknown> }

/** The plan a tool call is, if it's one: ExitPlanMode's plan, or a file written into the plans folder. */
function planIn(block: Block, plans: string): FoundPlan | null {
  if (block.type !== 'tool_use' || !block.input) return null
  const input = block.input
  if (block.name === 'ExitPlanMode') {
    if (typeof input.planFilePath === 'string' && isDocPath(input.planFilePath)) return { kind: 'file', path: input.planFilePath, what: 'plan file' }
    if (typeof input.plan === 'string' && input.plan.trim()) return { kind: 'text', text: input.plan, what: 'plan' }
  }
  if ((block.name === 'Write' || block.name === 'Edit') && typeof input.file_path === 'string' && isDocPath(input.file_path) && inFolder(input.file_path, plans)) {
    return { kind: 'file', path: input.file_path, what: 'plan file' }
  }
  return null
}

/**
 * The newest plan in a conversation's lines, or failing that its newest long answer. A plan wins over a later answer:
 * the action is "Open plan", and a plan is what the person comments on before the agent starts.
 */
export function findPlan(lines: string[], home: string): FoundPlan | null {
  const plans = plansFolder(home)
  let answer: FoundPlan | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    let entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type === 'assistant' && !entry.isSidechain && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as Block[]) {
        const plan = planIn(block, plans)
        if (plan) return plan
      }
    }
    if (!answer) {
      const m = parseLine(line)
      if (m?.role === 'assistant' && isLongMarkdown(m.text)) answer = { kind: 'text', text: m.text, what: 'answer' }
    }
  }
  return answer
}

/** How much of the end of a transcript is searched. A plan is made near the end of a conversation's latest turns. */
export const PLAN_TAIL_BYTES = 16 * 1024 * 1024

/** The complete lines at the end of a transcript, up to PLAN_TAIL_BYTES. */
export async function tailLines(path: string, bytes = PLAN_TAIL_BYTES): Promise<string[]> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    // A read that starts mid-file starts mid-line.
    return start > 0 ? lines.slice(1) : lines
  } finally {
    await file.close()
  }
}
