import { parseLine } from '../transcript/read'

/**
 * What happened in a conversation, line by line: messages, file edits and commands. Read from Claude Code transcripts
 * and Codex rollout files, in Codex's older form (user_message, function_call) and its current one (item_completed).
 *
 * Nothing here guesses. An edit or command's `ok` is null until the transcript records how it went: a tool that was
 * called but whose result never came, or a command still running in the background, stays null. A background
 * command is settled only by its own completion notice, never by the notice that it started.
 */
export type TranscriptEvent =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; at?: number }
  | { kind: 'edit'; path: string; ok: boolean | null; at?: number }
  | { kind: 'command'; command: string; ok: boolean | null; output?: string; background?: true; at?: number }

type CommandEvent = Extract<TranscriptEvent, { kind: 'command' }>
type EditEvent = Extract<TranscriptEvent, { kind: 'edit' }>

/** Claude's answer when Bash moves a command to the background: its result is still to come. */
const BACKGROUND_STARTED = /running in background with ID:\s*([A-Za-z0-9_-]+)/
/** Claude's notice that a background command ended, naming the tool call that started it. */
const TASK_DONE = /<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>((?:(?!<\/task-notification>)[\s\S])*)/g
/** BashOutput and TaskOutput results, and completion notices, say a background command's state and exit code. */
const STATUS = /<status>(\w+)<\/status>/
const EXIT_TAG = /<exit_code>(-?\d+)<\/exit_code>/
const EXIT_WORDS = /exit code:? (-?\d+)/

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

/** How a Codex patch's result reads: a success, a failure, or not said. */
function patchOutcome(output: unknown): boolean | null {
  let text = typeof output === 'string' ? output : ''
  let code: unknown
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      code = parsed.metadata?.exit_code
      text = typeof parsed.output === 'string' ? parsed.output : text
    }
  } catch {
    // Plain text.
  }
  if (typeof code === 'number') return code === 0
  if (/^\s*Success\b/i.test(text)) return true
  if (/\b(error|failed|rejected|declined|aborted)\b/i.test(text)) return false
  return null
}

/** A background command's outcome from a status and exit code: unknown unless an exit code, or a failure, says. */
function endedOk(status: string | undefined, exit: string | undefined): boolean | null {
  if (exit !== undefined) return Number(exit) === 0
  return status === 'completed' || status === undefined ? null : false
}

/**
 * Reads lines one at a time. Results of tool calls arrive on later lines than the calls, so it keeps the edits and
 * commands still waiting, by the id the transcript gives them.
 */
export function createEventReader(): { line(line: string): TranscriptEvent[] } {
  const pending = new Map<string, { command?: CommandEvent; edits: EditEvent[] }>()
  /** Background commands by the shell id Claude gave them, for BashOutput and TaskOutput to settle. */
  const shells = new Map<string, CommandEvent>()
  /** BashOutput and TaskOutput calls, by their own id, to the shell id they asked about. */
  const outputs = new Map<string, string>()
  const settleCommand = (command: CommandEvent, ok: boolean | null, output: string): void => {
    command.ok = ok
    if (output.trim()) command.output = tail(output.trim())
  }
  const forget = (command: CommandEvent): void => {
    for (const [shell, c] of shells) if (c === command) shells.delete(shell)
    for (const [id, w] of pending) if (w.command === command) pending.delete(id)
  }
  /** A tool's result. Edits learn whether they were made; a command too, unless it went on in the background. */
  const settle = (id: unknown, ok: boolean | null, output: string): void => {
    if (typeof id !== 'string') return
    const shell = outputs.get(id)
    if (shell !== undefined) {
      outputs.delete(id)
      const command = shells.get(shell)
      const status = output.match(STATUS)?.[1]
      if (command && status && status !== 'running') {
        forget(command)
        settleCommand(command, endedOk(status, output.match(EXIT_TAG)?.[1]), output)
      }
      return
    }
    const waiting = pending.get(id)
    if (!waiting) return
    for (const e of waiting.edits) e.ok = ok
    const command = waiting.command
    const started = command && ok !== false ? output.match(BACKGROUND_STARTED) : null
    if (command && (started || (command.background && ok !== false))) {
      // Only started: the outcome comes later, from its completion notice, or not at all.
      command.background = true
      pending.set(id, { command, edits: [] })
      if (started) shells.set(started[1], command)
      return
    }
    pending.delete(id)
    if (command) settleCommand(command, ok, output)
  }
  const command = (id: unknown, text: string, at: number | undefined, background = false): CommandEvent => {
    const event: CommandEvent = { kind: 'command', command: text, ok: null, ...(background ? { background: true as const } : {}), ...(at !== undefined ? { at } : {}) }
    if (typeof id === 'string') pending.set(id, { command: event, edits: [] })
    return event
  }
  const edit = (id: unknown, path: string, at: number | undefined): EditEvent => {
    const event: EditEvent = { kind: 'edit', path, ok: null, ...(at !== undefined ? { at } : {}) }
    if (typeof id === 'string') {
      const waiting = pending.get(id) ?? { edits: [] }
      waiting.edits.push(event)
      pending.set(id, waiting)
    }
    return event
  }
  /** Claude's notices that background commands ended, wherever in a line they appear. */
  const backgroundDone = (line: string): void => {
    if (!line.includes('task-notification')) return
    for (const m of line.matchAll(TASK_DONE)) {
      const command = pending.get(m[1])?.command
      if (!command?.background) continue
      const status = m[2].match(STATUS)?.[1]
      if (!status || status === 'running') continue
      forget(command)
      settleCommand(command, endedOk(status, m[2].match(EXIT_WORDS)?.[1]), '')
    }
  }

  function claude(entry: Record<string, any>, at: number | undefined): TranscriptEvent[] {
    const content = entry.message?.content
    if (!Array.isArray(content)) return []
    const out: TranscriptEvent[] = []
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const field = CLAUDE_EDITS[block.name]
        const path = field ? block.input?.[field] : undefined
        if (typeof path === 'string' && path) out.push(edit(block.id, path, at))
        else if (block.name === 'Bash' && typeof block.input?.command === 'string') out.push(command(block.id, block.input.command, at, block.input.run_in_background === true))
        else if ((block.name === 'BashOutput' || block.name === 'TaskOutput') && typeof block.id === 'string') {
          const shell = block.input?.bash_id ?? block.input?.task_id ?? block.input?.shell_id
          if (typeof shell === 'string') outputs.set(block.id, shell)
        }
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
        // Only a completed change happened. A failed or declined one didn't, and any other status isn't known.
        const ok = item.status === 'completed' ? true : item.status === 'failed' || item.status === 'declined' ? false : null
        return Object.entries(changes).flatMap(([path, change]) => {
          const moved = (change as { move_path?: unknown })?.move_path
          return [{ kind: 'edit' as const, path, ok, ...when }, ...(typeof moved === 'string' && moved ? [{ kind: 'edit' as const, path: moved, ok, ...when }] : [])]
        })
      }
      default:
        return []
    }
  }

  function codexResponse(payload: Record<string, any>, at: number | undefined): TranscriptEvent[] {
    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && typeof payload.input === 'string') {
      return patchFiles(payload.input).map((path) => edit(payload.call_id, path, at))
    }
    if (payload.type === 'custom_tool_call_output') {
      const waiting = typeof payload.call_id === 'string' ? pending.get(payload.call_id) : undefined
      if (waiting && !waiting.command) {
        pending.delete(payload.call_id)
        const ok = patchOutcome(textBlocks(payload.output) || payload.output)
        for (const e of waiting.edits) e.ok = ok
      }
      return []
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
      backgroundDone(line)
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
