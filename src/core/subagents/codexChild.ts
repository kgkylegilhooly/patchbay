import type { Progress } from './parse'

/**
 * A Codex subagent's own rollout file, read for its card: tool calls, the context size of its latest reply, its
 * prompt and whether it ended on an error. Codex writes a child as a separate rollout (a `spawn_agent` thread), and
 * its SubagentStop hook names that file (`agent_transcript_path`). Pure; lines are fed as they're read.
 */

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call'])

function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    const p = obj(part)
    if (p && typeof p.text === 'string' && p.text.trim()) return p.text
  }
  return ''
}

/** Folds rollout lines (several, newline-separated) into a card's progress. */
export function foldCodexChild(progress: Progress, text: string): Progress {
  let out = progress
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let line: Record<string, unknown> | null
    try {
      line = obj(JSON.parse(raw))
    } catch {
      continue
    }
    if (!line) continue
    const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN
    if (!Number.isNaN(at)) out = { ...out, startedAt: out.startedAt ?? at, lastAt: at }
    const p = obj(line.payload)
    if (!p) continue
    if (line.type === 'response_item') {
      if (typeof p.type === 'string' && TOOL_ITEMS.has(p.type)) out = { ...out, tools: out.tools + 1 }
      else if (p.type === 'message' && p.role === 'user' && out.prompt === undefined) {
        const said = firstText(p.content).trim()
        // Codex puts its own context in user messages wrapped in tags; the prompt is the first plain one.
        if (said && !said.startsWith('<')) out = { ...out, prompt: said.split('\n')[0].slice(0, 200) }
      } else if (p.type === 'message' && p.role === 'assistant' && out.error) {
        const { error: _cleared, ...rest } = out
        out = rest
      }
    } else if (line.type === 'event_msg') {
      if (p.type === 'token_count') {
        const last = obj(obj(p.info)?.last_token_usage)
        const total = typeof last?.total_tokens === 'number' ? last.total_tokens : null
        if (total !== null) out = { ...out, tokens: total }
      } else if (p.type === 'error') {
        out = { ...out, error: typeof p.message === 'string' && p.message ? p.message.slice(0, 200) : 'It ended on an error' }
      } else if (p.type === 'user_message' && out.prompt === undefined && typeof p.message === 'string' && p.message.trim()) {
        out = { ...out, prompt: p.message.trim().split('\n')[0].slice(0, 200) }
      }
    }
  }
  return out
}
