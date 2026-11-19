import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { parseLine } from '../../core/transcript/read'

/**
 * Whether a message typed into an agent arrived as sent, going by the agent's own transcript: Claude Code's session
 * file or Codex's rollout. Typing can go wrong without any error. A long message once lost its first kilobyte on the
 * way in, and `send` still said delivered.
 */
export type DeliveryCheck =
  | { result: 'confirmed' }
  /** A new message shares only the start or only the end of what was sent. */
  | { result: 'garbled'; received: string }
  | { result: 'unconfirmed'; reason: 'no-transcript' | 'timeout' }

export interface DeliveryTiming {
  /** How long to wait for the message to show up in the transcript. */
  confirmMs: number
  pollMs: number
}

export const DEFAULT_DELIVERY_TIMING: DeliveryTiming = { confirmMs: 10_000, pollMs: 250 }

/** How much of each end is compared. */
const ENDS = 40

/** Line endings, runs of spaces and tabs can change on the way in, and don't matter. */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Claude Code (2.1.327) can submit a pasted message between `<pasted_content id="1a2b">` and
 * `</pasted_content id="1a2b">` lines. The message inside is whole.
 */
const PASTE_TAGS = /<\/?pasted_content id="[0-9a-f]{4}">/g

/**
 * match: starts and ends as the message did. partial: only one end does, and it's shorter, as when its start was
 * lost. other: something else, such as what the person typed.
 */
export function compareDelivered(sent: string, received: string): 'match' | 'partial' | 'other' {
  const s = squash(sent)
  const r = squash(received.replace(PASTE_TAGS, ''))
  const head = s.slice(0, ENDS)
  const tail = s.slice(-ENDS)
  if (r.startsWith(head) && r.endsWith(tail)) return 'match'
  // A short message's ends are most of it, so sharing one says nothing.
  if (s.length >= ENDS * 2 && r.length < s.length && (r.startsWith(head) || r.endsWith(tail))) return 'partial'
  return 'other'
}

/** Where the transcript ends now, so only what's added after counts. Null when there's no file yet. */
export function transcriptEnd(path: string | null | undefined): number | null {
  if (!path) return null
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** The user messages in the complete lines added since `from`, and where those lines end. */
async function userMessagesSince(path: string, from: number): Promise<{ messages: string[]; end: number }> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return { messages: [], end: from }
  }
  try {
    const { size } = await handle.stat()
    // Shorter than before: it was replaced, so it's read from the start.
    const start = size < from ? 0 : from
    if (size === start) return { messages: [], end: start }
    const buffer = Buffer.alloc(size - start)
    let at = 0
    while (at < buffer.length) {
      const { bytesRead } = await handle.read(buffer, at, buffer.length - at, start + at)
      if (bytesRead === 0) break
      at += bytesRead
    }
    // A line still being written is read next time.
    const complete = buffer.subarray(0, buffer.subarray(0, at).lastIndexOf(0x0a) + 1)
    const messages = complete
      .toString('utf8')
      .split('\n')
      .map((line) => (line.trim() ? parseLine(line) : null))
      .filter((m) => m?.role === 'user')
      .map((m) => m!.text)
    return { messages, end: start + complete.length }
  } finally {
    await handle.close()
  }
}

/**
 * Waits for the message to show up in the transcript after `from` (see transcriptEnd, taken before Enter). Settles as
 * soon as a new user message matches or is garbled, or when time runs out.
 */
export async function confirmDelivery({
  path,
  from,
  sent,
  timing = DEFAULT_DELIVERY_TIMING
}: {
  path: string | null | undefined
  from: number | null
  sent: string
  timing?: DeliveryTiming
}): Promise<DeliveryCheck> {
  if (!path) return { result: 'unconfirmed', reason: 'no-transcript' }
  const until = Date.now() + timing.confirmMs
  let offset = from ?? 0
  for (;;) {
    const { messages, end } = await userMessagesSince(path, offset)
    offset = end
    for (const text of messages) {
      const seen = compareDelivered(sent, text)
      if (seen === 'match') return { result: 'confirmed' }
      if (seen === 'partial') return { result: 'garbled', received: text }
    }
    if (Date.now() >= until) return { result: 'unconfirmed', reason: 'timeout' }
    await new Promise((r) => setTimeout(r, timing.pollMs))
  }
}

/** A short excerpt of what arrived, for a report. */
export function excerpt(text: string, max = 120): string {
  const t = squash(text)
  return t.length <= max ? t : `${t.slice(0, max / 2)} ... ${t.slice(-max / 2)}`
}

/** The fields a check adds to `send`'s answer. `delivered` keeps its meaning, except that a damaged copy isn't one. */
export interface DeliveryReport {
  delivered: boolean
  confirmed: boolean
  garbled?: true
  /** In words, for the sender. Only when it isn't confirmed. */
  problem?: string
}

export function reportDelivery(check: DeliveryCheck, nodeId: string, timing: DeliveryTiming = DEFAULT_DELIVERY_TIMING): DeliveryReport {
  if (check.result === 'confirmed') return { delivered: true, confirmed: true }
  if (check.result === 'garbled') {
    return {
      delivered: false,
      confirmed: false,
      garbled: true,
      problem: `Node "${nodeId}" got a damaged copy of the message. Its transcript shows only: "${excerpt(check.received)}". Send it again.`
    }
  }
  const problem =
    check.reason === 'no-transcript'
      ? `The message was typed into node "${nodeId}", but it has no transcript yet, so Patchbay couldn't check that it arrived.`
      : `The message was typed into node "${nodeId}", but it didn't show up in the node's transcript within ${Math.round(timing.confirmMs / 1000)} s. ` +
        `Check with patchbay read --node ${nodeId} --tail 2 before sending it again.`
  return { delivered: true, confirmed: false, problem }
}
