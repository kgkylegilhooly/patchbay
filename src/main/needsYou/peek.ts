import { pendingToolOf, tailLines } from '../../core/transcript/peek'
import { readMessagesTail } from '../../core/transcript/read'
import type { CanvasDoc } from '../../shared/model'
import type { SessionPeek, WaitSince } from '../../shared/needsYouBridge'

/** As much of a long last message as a peek shows: its end, where a question usually is. */
export const MESSAGE_MAX = 4000

const ending = (text: string): string => (text.length <= MESSAGE_MAX ? text : '…' + text.slice(-(MESSAGE_MAX - 1)).replace(/^[\udc00-\udfff]/, ''))

export interface PeekDeps {
  doc: () => CanvasDoc
  since: (id: string) => WaitSince | undefined
}

/** A session's peek, from its transcript. A transcript that isn't there yet is an empty conversation, not a problem. */
export async function peekSession(deps: PeekDeps, id: string): Promise<{ ok: true; peek: SessionPeek } | { ok: false; reason: string }> {
  const node = deps.doc().nodes.find((n) => n.id === id)
  if (node?.kind !== 'claude') return { ok: false, reason: 'Only an agent window can be peeked at.' }
  const peek: SessionPeek = { since: deps.since(id) ?? null, lastMessage: null, pending: null, problem: null }
  if (!node.transcriptPath) return { ok: true, peek }
  try {
    const said = (await readMessagesTail(node.transcriptPath, 8)).filter((m) => m.role === 'assistant').pop()
    peek.lastMessage = said ? ending(said.text.trim()) : null
    peek.pending = pendingToolOf(await tailLines(node.transcriptPath))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') peek.problem = `The conversation couldn't be read: ${(e as Error).message}`
  }
  return { ok: true, peek }
}
