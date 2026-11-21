/**
 * Reading what Claude Code writes for each subagent, beside the parent's transcript:
 * `<transcript without .jsonl>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`. See docs/plans/subagent-cards.md.
 * Pure, so it runs anywhere: the folder itself is found in src/main/subagents/watcher.ts.
 */

export interface SubagentMeta {
  agentType: string
  description: string
  /** Written only once the agent has finished. */
  finished: boolean
  stoppedByUser: boolean
  depth: number
}

/** `agent-<id>.jsonl` → id, for the transcript files only. */
export function agentIdOf(fileName: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/.exec(fileName)
  return m ? m[1] : null
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** A meta file's text, or null when it isn't one (yet: it may be read mid-write). */
export function parseMeta(text: string): SubagentMeta | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  return {
    agentType: str(m.agentType, 60) || 'agent',
    description: str(m.description),
    finished: m.finished === true,
    stoppedByUser: m.stoppedByUser === true,
    depth: typeof m.spawnDepth === 'number' && m.spawnDepth >= 1 ? Math.min(9, Math.floor(m.spawnDepth)) : 1
  }
}

/** What has been learned from a subagent's transcript so far, read a piece at a time. */
export interface Progress {
  tools: number
  tokens?: number
  startedAt?: number
  lastAt?: number
  /** The first line of its prompt, for when there's no meta to describe it. */
  prompt?: string
  /** Set while its latest reply is an API error. */
  error?: string
  /** Codex only: still reading the parent's history a forked child's rollout starts with. */
  inherited?: boolean
  /** Codex only: the agent path of the parent that started this child ("/root" for "/root/pong"), when known. */
  startedBy?: string
}

export const emptyProgress = (): Progress => ({ tools: 0 })

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/**
 * Folds complete transcript lines into what's known. Broken lines are skipped. Tokens are the context size of the latest
 * reply, which is what Claude reports to the parent as the subagent's tokens.
 */
export function foldLines(p: Progress, text: string): Progress {
  const next = { ...p }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const at = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (Number.isFinite(at)) {
      next.startedAt ??= at
      next.lastAt = at
    }
    if (e?.type === 'user' && next.prompt === undefined) {
      const first = textOf(e.message?.content).trim().split('\n')[0]
      if (first) next.prompt = first.slice(0, 200)
    }
    if (e?.type !== 'assistant') continue
    const msg = e.message ?? {}
    for (const block of Array.isArray(msg.content) ? msg.content : []) if (block?.type === 'tool_use') next.tools++
    // Every line of a message repeats its usage, so the latest line holds the latest reading.
    const usage = msg.usage as Usage | undefined
    if (usage) {
      const total = num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens)
      if (total > 0) next.tokens = total
    }
    next.error = e.isApiErrorMessage ? textOf(msg.content).trim().split('\n')[0].slice(0, 200) || 'The agent stopped on an API error.' : undefined
  }
  return next
}

const toolSummary = (block: { name?: unknown; input?: Record<string, unknown> }): string => {
  const input = block.input ?? {}
  const what = ['description', 'file_path', 'command', 'pattern', 'url', 'path', 'query'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined
  return `[${str(block.name, 40) || 'tool'}]${what ? ` ${what.split('\n')[0].slice(0, 160)}` : ''}`
}

/** A subagent's transcript as plain text for reading: its prompt, its replies and the tools it called. */
export function subagentTranscriptText(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue // Still being written.
    }
    if (e?.type === 'user') {
      const said = textOf(e.message?.content)
      if (said.trim()) out.push(`[prompt]\n${said}\n`)
    } else if (e?.type === 'assistant') {
      const content = Array.isArray(e.message?.content) ? e.message.content : []
      const said = textOf(content)
      if (said.trim()) out.push(`[${e.isApiErrorMessage ? 'error' : 'assistant'}]\n${said}\n`)
      for (const block of content) if (block?.type === 'tool_use') out.push(`${toolSummary(block)}\n`)
    }
  }
  return out.join('\n')
}
