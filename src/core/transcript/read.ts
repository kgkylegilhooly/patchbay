import { readFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

/** Slash commands and their output, which Claude records as user messages though nobody wrote them. */
const LOCAL_COMMAND = /^\s*<(command-|local-command-)/

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  /** Codex only: a note it wrote on its way through a turn ("I'll run the tests"), not its answer. */
  commentary?: true
}
type Message = TranscriptMessage

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** A Codex item's text parts: `text` in a UserMessage, `Text` in an AgentMessage. */
function codexText(content: unknown[]): string {
  return content
    .filter((b): b is { text: string } => !!b && typeof b === 'object' && ((b as { type?: unknown }).type === 'text' || (b as { type?: unknown }).type === 'Text') && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** One transcript line as a message, or null for anything else. Also used by the search index. */
export function parseLine(line: string): Message | null {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return null // A session still writing leaves a partial final line.
  }
  // Codex's rollout files say each turn twice. Its events are the plain conversation, without system text: since 0.167
  // `item_completed` with a UserMessage or AgentMessage item (test/fixtures/codex-0.170), before that
  // `user_message` / `agent_message`. Its `response_item` messages also hold the context Codex adds, so aren't read.
  if (entry?.type === 'event_msg') {
    const { type, message, item } = entry.payload ?? {}
    if (type === 'item_completed') {
      const role = item?.type === 'UserMessage' ? 'user' : item?.type === 'AgentMessage' ? 'assistant' : null
      const said = role && Array.isArray(item.content) ? codexText(item.content) : ''
      if (!role || !said.trim()) return null
      return role === 'assistant' && item.phase === 'commentary' ? { role, text: said, commentary: true } : { role, text: said }
    }
    const role = type === 'user_message' ? 'user' : type === 'agent_message' ? 'assistant' : null
    return role && typeof message === 'string' && message.trim() ? { role, text: message } : null
  }
  // Filter on the line's type: other line types, such as api-request-blob, also carry a message role.
  if (entry?.type !== 'user' && entry?.type !== 'assistant') return null
  if (entry.isMeta || entry.isSidechain) return null
  const text = textOf(entry.message?.content)
  if (!text.trim() || LOCAL_COMMAND.test(text)) return null
  return { role: entry.type, text }
}

/** The conversation, message by message. `tail` keeps the last N. Throws if the file can't be read. */
export function readMessages(path: string, tail?: number): TranscriptMessage[] {
  const messages = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map(parseLine)
    .filter((m): m is Message => m !== null)
  return tail === undefined ? messages : messages.slice(-tail)
}

/** How much of the end of a transcript is read first. Grown until it holds enough messages. */
const TAIL_CHUNK_BYTES = 256 * 1024

/** The messages in the complete lines of a stretch of the file. */
function parseText(text: string): Message[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map(parseLine)
    .filter((m): m is Message => m !== null)
}

interface TailCache {
  /** Bytes read, up to the end of the last complete line. */
  offset: number
  mtimeMs: number
  messages: Message[]
  /** Holds every message in the file, so a short conversation is never read whole again. */
  whole: boolean
}
/** Kept per file, so a conversation read again every few seconds costs only what was added since. */
const tails = new Map<string, TailCache>()
const TAIL_CACHE_FILES = 64

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start)
  let at = 0
  while (at < buffer.length) {
    const { bytesRead } = await handle.read(buffer, at, buffer.length - at, start + at)
    if (bytesRead === 0) break
    at += bytesRead
  }
  return buffer.subarray(0, at)
}

/**
 * The last `tail` messages, without blocking. Agents' transcripts run to tens of megabytes, and reading one whole on
 * every refresh held up everything else in the app. This reads from the end only as far back as it takes, and after
 * that only what was added. Throws if the file can't be read.
 */
export async function readMessagesTail(path: string, tail: number): Promise<TranscriptMessage[]> {
  const handle = await open(path, 'r')
  try {
    const { size, mtimeMs } = await handle.stat()
    const cached = tails.get(path)
    // Transcripts only grow. One that's shorter than what was read has been replaced, so it's read afresh.
    if (cached && cached.offset <= size && (cached.whole || cached.messages.length >= tail)) {
      if (cached.offset === size) return cached.messages.slice(-tail)
      // Only what was added, up to its last complete line. A line still being written is read next time.
      const added = await readRange(handle, cached.offset, size)
      const end = added.lastIndexOf(0x0a) + 1
      const all = [...cached.messages, ...parseText(added.subarray(0, end).toString('utf8'))]
      tails.set(path, { offset: cached.offset + end, mtimeMs, messages: all.slice(-tail * 2), whole: cached.whole && all.length <= tail * 2 })
      return all.slice(-tail)
    }
    let chunk = TAIL_CHUNK_BYTES
    for (;;) {
      const start = Math.max(0, size - chunk)
      const bytes = await readRange(handle, start, size)
      const end = bytes.lastIndexOf(0x0a) + 1
      // Read from partway in, the first line is only the end of one.
      const first = start === 0 ? 0 : bytes.indexOf(0x0a) + 1
      const messages = first > 0 || start === 0 ? parseText(bytes.subarray(first, end).toString('utf8')) : []
      if (messages.length >= tail || start === 0) {
        if (tails.size >= TAIL_CACHE_FILES) tails.delete(tails.keys().next().value as string)
        tails.set(path, { offset: start + end, mtimeMs, messages: messages.slice(-tail * 2), whole: start === 0 && messages.length <= tail * 2 })
        return messages.slice(-tail)
      }
      chunk *= 4
    }
  } finally {
    await handle.close()
  }
}

/** As `patchbay read` shows it. A Codex note on the way is marked, so it isn't taken for the answer. */
const asText = (messages: Message[]): string => messages.map((m) => `[${m.role}${m.commentary ? ', on the way' : ''}]\n${m.text}\n`).join('\n')

/** How much of a whole transcript is parsed before giving everything else waiting on the thread a turn. */
const WHOLE_CHUNK_BYTES = 512 * 1024

/**
 * Every message, a stretch at a time, letting the rest of the thread run between stretches. Parsing a long agent's
 * transcript in one go held up the main process, and every window with it, for as long as it took.
 */
export async function readAllMessages(path: string): Promise<TranscriptMessage[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const messages: Message[] = []
    let at = 0
    while (at < size) {
      if (at > 0) await new Promise<void>((r) => setImmediate(r))
      const bytes = await readRange(handle, at, Math.min(size, at + WHOLE_CHUNK_BYTES))
      if (bytes.length === 0) break
      // A stretch ends at its last complete line; one longer than a stretch is read whole.
      let end = bytes.lastIndexOf(0x0a) + 1
      let chunk = bytes.subarray(0, end)
      // A line longer than a stretch, such as a pasted screenshot: read twice as far each time until it ends.
      for (let span = WHOLE_CHUNK_BYTES * 2; end === 0; span *= 2) {
        const want = Math.min(size, at + span) - at
        const longer = await readRange(handle, at, at + want)
        const nl = longer.indexOf(0x0a)
        // The end of the file, or of what's there now if it was cut short meanwhile, ends the line.
        if (nl === -1 && longer.length === want && at + want < size) continue
        end = nl !== -1 ? nl + 1 : longer.length
        chunk = longer.subarray(0, end)
        break
      }
      if (end === 0) break
      for (const m of parseText(chunk.toString('utf8'))) messages.push(m)
      at += end
    }
    return messages
  } finally {
    await handle.close()
  }
}

/** The last `tail` messages as plain text, or every message without one, read without blocking. Throws if the file can't be read. */
export async function readTranscriptAsync(path: string, tail?: number): Promise<string> {
  if (tail !== undefined) return asText(await readMessagesTail(path, tail))
  return asText(await readAllMessages(path))
}

/** The conversation as plain text. `tail` keeps the last N messages. Throws if the file can't be read. */
export function readTranscript(path: string, tail?: number): string {
  return asText(readMessages(path, tail))
}

// Order matters: strings first, so their contents can't be mistaken for shorter sequences.
const ESCAPES = new RegExp(
  [
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?', // OSC, such as a window title
    '\\x1b[PX^_][\\s\\S]*?(?:\\x1b\\\\|$)', // DCS, SOS, PM, APC
    '\\x1b\\[[0-?]*[ -/]*[@-~]', // CSI, such as colors and cursor moves
    '\\x1b[ -/]*[0-~]' // Everything else with an ESC, such as a charset choice
  ].join('|'),
  'g'
)

/** Terminal output as readable text. It can't undo cursor moves, so a full-screen program stays jumbled. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(ESCAPES, '')
    .replace(/\r+\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** The last N lines, not counting blank ones at the end. Without N, the text is unchanged. */
export function lastLines(text: string, count?: number): string {
  if (count === undefined) return text
  const lines = text.replace(/\n+$/, '').split('\n')
  return `${lines.slice(-count).join('\n')}\n`
}
