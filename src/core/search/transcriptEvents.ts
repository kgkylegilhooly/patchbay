import { parseLine } from '../transcript/read'

/**
 * What happened in a conversation, line by line: messages, file edits and commands. Read from Claude Code transcripts
 * and Codex rollout files, in Codex's older form (user_message, function_call) and its current one (item_completed).
 * Nothing here guesses: a command's outcome is null unless the transcript recorded one.
 */
export type TranscriptEvent =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; at?: number }
  | { kind: 'edit'; path: string; at?: number }
  | { kind: 'command'; command: string; ok: boolean | null; output?: string; at?: number }

/** A command waiting for its result, which comes on a later line. */
type CommandEvent = Extract<TranscriptEvent, { kind: 'command' }>

/** Tools that change a file, and where they name it. */
const CLAUDE_EDITS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const OUTPUT_CHARS = 600

function timeOf(entry: { timestamp?: unknown }): number | undefined {
  if (typeof entry?.timestamp !== 'string') return undefined
  const ms = Date.parse(entry.timestamp)
  return Number.isFinite(ms) ? ms : undefined
}

const tail = (text: string): string => (text.length > OUTPUT_CHARS ? `…${text.slice(-OUTPUT_CHARS)}` : text)

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => (b?.type === 'text' || b?.type === 'Text' || b?.type === 'input_text' || b?.type === 'output_text') && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** A Codex command as the person would type it: PowerShell's script, or the words joined. */
function commandText(command: unknown): string {
  if (typeof command === 'string') return command
  if (!Array.isArray(command)) return ''
  const words = command.filter((w): w is string => typeof w === 'string')
  const flag = words.findIndex((w) => /^-(c|lc|Command)$/i.test(w))
  return flag !== -1 && flag < words.length - 1 ? words.slice(flag + 1).join(' ') : words.join(' ')
}

/** The files a patch in Codex's apply_patch form touches. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
}

/**
 * Reads lines one at a time. Results of commands arrive on later lines than the commands, so it keeps the commands
 * still waiting, by the id the transcript gives them.
 */
export function createEventReader(): { line(line: string): TranscriptEvent[] } {
  const pending = new Map<string, CommandEvent>()
  const settle = (id: unknown, ok: boolean | null, output: string): void => {
    const command = typeof id === 'string' ? pending.get(id) : undefined
    if (!command) return
    pending.delete(id as string)
    command.ok = ok
    if (output.trim()) command.output = tail(output.trim())
  }
  const command = (id: unknown, text: string, at: number | undefined): CommandEvent => {
    const event: CommandEvent = { kind: 'command', command: text, ok: null, ...(at !== undefined ? { at } : {}) }
    if (typeof id === 'string') pending.set(id, event)
    return event
  }

  function claude(entry: Record<string, any>, at: number | undefined): TranscriptEvent[] {
    const content = entry.message?.content
    if (!Array.isArray(content)) return []
    const out: TranscriptEvent[] = []
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const field = CLAUDE_EDITS[block.name]
        const path = field ? block.input?.[field] : undefined
        if (typeof path === 'string' && path) out.push({ kind: 'edit', path, ...(at !== undefined ? { at } : {}) })
        else if (block.name === 'Bash' && typeof block.input?.command === 'string') out.push(command(block.id, block.input.command, at))
      } else if (block?.type === 'tool_result') {
        settle(block.tool_use_id, block.is_error === true ? false : true, textBlocks(block.content))
      }
    }
    return out
  }

  function codexItem(item: Record<string, any>, at: number | undefined): TranscriptEvent[] {
    const when = at !== undefined ? { at } : {}
    switch (item?.type) {
      case 'UserMessage':
      case 'AgentMessage': {
        const text = textBlocks(item.content)
        return text.trim() ? [{ kind: 'message', role: item.type === 'UserMessage' ? 'user' : 'assistant', text, ...when }] : []
      }
      case 'CommandExecution': {
        const text = commandText(item.command)
        if (!text) return []
        const ok = typeof item.exit_code === 'number' ? item.exit_code === 0 : item.status === 'failed' ? false : null
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : ''
        return [{ kind: 'command', command: text, ok, ...(output ? { output: tail(output) } : {}), ...when }]
      }
      case 'FileChange': {
        const changes = item.changes && typeof item.changes === 'object' ? item.changes : {}
        return Object.entries(changes).flatMap(([path, change]) => {
          const moved = (change as { move_path?: unknown })?.move_path
          return [{ kind: 'edit' as const, path, ...when }, ...(typeof moved === 'string' && moved ? [{ kind: 'edit' as const, path: moved, ...when }] : [])]
        })
      }
      default:
        return []
    }
  }

  function codexResponse(payload: Record<string, any>, at: number | undefined): TranscriptEvent[] {
    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && typeof payload.input === 'string') {
      return patchFiles(payload.input).map((path) => ({ kind: 'edit' as const, path, ...(at !== undefined ? { at } : {}) }))
    }
    if (payload.type === 'function_call' && (payload.name === 'shell' || payload.name === 'local_shell')) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(String(payload.arguments ?? '{}'))
      } catch {
        return []
      }
      const text = commandText(args.command)
      return text ? [command(payload.call_id, text, at)] : []
    }
    if (payload.type === 'function_call_output') {
      let output: { output?: unknown; metadata?: { exit_code?: unknown } } = {}
      try {
        output = typeof payload.output === 'string' ? JSON.parse(payload.output) : (payload.output ?? {})
      } catch {
        output = { output: payload.output }
      }
      const code = output?.metadata?.exit_code
      settle(payload.call_id, typeof code === 'number' ? code === 0 : null, typeof output?.output === 'string' ? output.output : '')
    }
    return []
  }

  return {
    line(line) {
      if (!line.trim()) return []
      let entry: Record<string, any>
      try {
        entry = JSON.parse(line)
      } catch {
        return [] // A line still being written, or a damaged one.
      }
      if (!entry || typeof entry !== 'object') return []
      const at = timeOf(entry)
      if (entry.type === 'event_msg' && entry.payload?.type === 'item_completed') return codexItem(entry.payload.item, at)
      if (entry.type === 'response_item' && entry.payload) return codexResponse(entry.payload, at)
      const out: TranscriptEvent[] = []
      // The conversation itself, as the chat view reads it.
      const message = parseLine(line)
      if (message) out.push({ kind: 'message', role: message.role, text: message.text, ...(at !== undefined ? { at } : {}) })
      if (entry.type === 'assistant' || entry.type === 'user') out.push(...claude(entry, at))
      return out
    }
  }
}

/** Every event in a transcript's text. A last line with no newline may be unfinished, so `complete` says whether it was read. */
export function transcriptEvents(text: string): { events: TranscriptEvent[]; partialLastLine: boolean } {
  const reader = createEventReader()
  const end = text.lastIndexOf('\n') + 1
  const events = text
    .slice(0, end)
    .split('\n')
    .flatMap((l) => reader.line(l))
  const rest = text.slice(end)
  if (!rest.trim()) return { events, partialLastLine: false }
  // A final line that parses whole is a finished line that only lacks its newline.
  const last = reader.line(rest)
  let whole = true
  try {
    JSON.parse(rest)
  } catch {
    whole = false
  }
  return whole ? { events: [...events, ...last], partialLastLine: false } : { events, partialLastLine: true }
}
