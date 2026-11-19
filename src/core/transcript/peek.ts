import { open } from 'node:fs/promises'
import type { PendingTool } from '../../shared/needsYouBridge'

export type { PendingTool }

/** The fields that say what a call does, in the order they're looked for. */
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'prompt', 'description']
const SUMMARY_MAX = 300

const cut = (line: string, max: number): string => (line.length <= max ? line : line.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '') + '…')

/** One line saying what a call would do, as the terminal's prompt would. AskUserQuestion is its first question. */
export function summarizeCall(tool: string, input: unknown): string {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  let text: string | undefined
  if (tool === 'AskUserQuestion' && Array.isArray(fields.questions)) {
    const first = fields.questions[0] as { question?: unknown } | undefined
    if (typeof first?.question === 'string') text = first.question
  }
  if (tool === 'ExitPlanMode' && typeof fields.plan === 'string') text = 'Approve the plan and start'
  text ??= SUMMARY_FIELDS.map((k) => fields[k]).find((v): v is string => typeof v === 'string' && v !== '')
  text ??= Object.keys(fields).length ? JSON.stringify(fields) : ''
  // Collapsing runs of whitespace stops padding from pushing the important part out of view.
  return cut(text.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim(), SUMMARY_MAX)
}

interface Block {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
}

/**
 * From the end of a transcript, as lines: the call still waiting on a result, if any. Lines that don't parse, side
 * conversations and anything that isn't a message are passed over. Claude's format; a Codex rollout gives null.
 */
export function pendingToolOf(lines: string[]): PendingTool | null {
  const open = new Map<string, PendingTool>()
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if ((entry?.type !== 'user' && entry?.type !== 'assistant') || entry.isSidechain || entry.isMeta) continue
    const content: unknown = entry.message?.content
    if (entry.type === 'user') {
      // A plain prompt means whatever was asked before is over.
      if (typeof content === 'string') open.clear()
      else if (Array.isArray(content)) {
        for (const b of content as Block[]) if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') open.delete(b.tool_use_id)
        if ((content as Block[]).some((b) => b?.type === 'text') && !(content as Block[]).some((b) => b?.type === 'tool_result')) open.clear()
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content as Block[]) {
      if (b?.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
      open.delete(b.id)
      open.set(b.id, { tool: b.name, summary: summarizeCall(b.name, b.input) })
    }
  }
  return [...open.values()].pop() ?? null
}

/** How much of the end of a transcript is read for the pending call. Its call is near the very end. */
const TAIL_BYTES = 128 * 1024

/** The complete lines in the last `bytes` of a file. Throws if it can't be read. */
export async function tailLines(path: string, bytes = TAIL_BYTES): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    let at = 0
    while (at < buffer.length) {
      const { bytesRead } = await handle.read(buffer, at, buffer.length - at, start + at)
      if (bytesRead === 0) break
      at += bytesRead
    }
    const lines = buffer.subarray(0, at).toString('utf8').split('\n')
    // Read from partway in, the first line is only the end of one.
    if (start > 0) lines.shift()
    return lines.filter((l) => l.trim())
  } finally {
    await handle.close()
  }
}
