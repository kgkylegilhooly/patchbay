/**
 * How much of a conversation an agent window's chat view shows. It opens on the newest page, and each "Show earlier"
 * adds a page. See docs/plans/r3-content.md.
 */
export const CONVERSATION_PAGE = 200
/** Past this, the chat view would be slow to draw. Older messages are still in the transcript, and the terminal. */
export const CONVERSATION_MAX = 5_000

/** What the window asked for, as a whole number of messages main will read: never under a page or over the most. */
export function conversationLimit(asked: unknown): number {
  const n = typeof asked === 'number' && Number.isFinite(asked) ? Math.floor(asked) : CONVERSATION_PAGE
  return Math.min(CONVERSATION_MAX, Math.max(CONVERSATION_PAGE, n))
}

/** The line at the top of the chat: earlier messages to show, the start, or as many as it shows. */
export function earlierRow(shown: number, earlier: boolean): { text: string; more: boolean } | null {
  if (!earlier) return shown >= CONVERSATION_PAGE ? { text: 'This is the start of the conversation.', more: false } : null
  if (shown >= CONVERSATION_MAX) return { text: `Earlier messages are in the transcript. This shows the last ${CONVERSATION_MAX.toLocaleString('en-US')}.`, more: false }
  return { text: `Earlier messages · showing the last ${shown.toLocaleString('en-US')}`, more: true }
}

export type ConversationMessage = { role: 'user' | 'assistant'; text: string }
/**
 * The chat view's answer. A window that already has the version main would send gets `unchanged` instead: a chat paged
 * back to thousands of messages was sent them all again every 2 seconds, changed or not.
 */
export type ConversationAnswer =
  | { ok: true; messages: ConversationMessage[]; earlier: boolean; version: string }
  | { ok: true; unchanged: true }
  | { ok: false; reason: string }

/** Names what was read: the same file, as far in, for the same number of messages, is the same answer. */
export function conversationVersion(path: string, limit: number, read: number): string {
  return `${limit}:${read}:${path}`
}

/** The answer to send, given what was read and the version the window already has. */
export function conversationAnswer(read: { messages: ConversationMessage[]; earlier: boolean; read: number }, path: string, limit: number, since: unknown): ConversationAnswer {
  const version = conversationVersion(path, limit, read.read)
  if (since === version) return { ok: true, unchanged: true }
  return { ok: true, messages: read.messages, earlier: read.earlier, version }
}
