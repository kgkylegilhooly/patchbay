/**
 * The prompts agents submitted, as their UserPromptSubmit hooks report them. `send` checks a message arrived in the
 * agent's transcript, and an agent that has only just started has no transcript yet: the hook carries the submitted
 * text either way, so it can confirm the message instead.
 */
export interface PromptWitness {
  /** A hook arrived. Only UserPromptSubmit with its text counts. */
  heard(id: string, payload: Record<string, unknown>): void
  /** Where this node's prompts stand now, so only later ones count. */
  mark(id: string): number
  /** The prompts heard from this node since the mark. */
  since(id: string, mark: number): string[]
  /** A node closed: what it submitted goes. */
  forget(id: string): void
}

/** A few are plenty: a check waits seconds, and an agent submits one prompt per turn. */
const KEPT = 4
/** Nodes kept, the least recently heard going first, so nodes the person removed don't pile up in memory. */
const NODES = 64

export function createPromptWitness(): PromptWitness {
  const seen = new Map<string, { count: number; texts: string[] }>()
  return {
    heard(id, payload) {
      if (payload.hook_event_name !== 'UserPromptSubmit' || typeof payload.prompt !== 'string') return
      const entry = seen.get(id) ?? { count: 0, texts: [] }
      entry.count += 1
      entry.texts.push(payload.prompt)
      if (entry.texts.length > KEPT) entry.texts.shift()
      seen.delete(id)
      seen.set(id, entry)
      if (seen.size > NODES) seen.delete(seen.keys().next().value!)
    },
    forget: (id) => void seen.delete(id),
    mark: (id) => seen.get(id)?.count ?? 0,
    since(id, mark) {
      const entry = seen.get(id)
      if (!entry || entry.count <= mark) return []
      return entry.texts.slice(-Math.min(entry.count - mark, entry.texts.length))
    }
  }
}
