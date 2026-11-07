import { readFileSync } from 'node:fs'

/** Slash commands and their output, which Claude records as user messages though nobody wrote them. */
const LOCAL_COMMAND = /^\s*<(command-|local-command-)/

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
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

function parseLine(line: string): Message | null {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return null // A session still writing leaves a partial final line.
  }
  // Codex's rollout files say each turn twice. Its events are the plain conversation, without system text.
  if (entry?.type === 'event_msg') {
    const { type, message } = entry.payload ?? {}
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

/** The conversation as plain text. `tail` keeps the last N messages. Throws if the file can't be read. */
export function readTranscript(path: string, tail?: number): string {
  return readMessages(path, tail)
    .map((m) => `[${m.role}]\n${m.text}\n`)
    .join('\n')
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
