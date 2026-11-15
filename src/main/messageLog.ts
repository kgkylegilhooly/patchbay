import type { NodeMessage } from '../shared/contract'

/** Messages kept, newest last. Older ones go first. None of it is saved: it's for watching a team while the app runs. */
const KEPT = 300
/** Enough to see what was asked. The whole text is in the receiving node's own conversation or terminal. */
const TEXT_CHARS = 2000

export interface MessageLog {
  add(from: string, to: string, text: string, at?: number): NodeMessage
  all(): NodeMessage[]
}

/** What nodes have sent each other with `patchbay send`, for the person to look back on from the cable between them. */
export function createMessageLog(): MessageLog {
  const kept: NodeMessage[] = []
  return {
    add(from, to, text, at = Date.now()) {
      const message = { from, to, text: text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text, at }
      kept.push(message)
      if (kept.length > KEPT) kept.splice(0, kept.length - KEPT)
      return message
    },
    all: () => [...kept]
  }
}
