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
}

/** A few are plenty: a check waits seconds, and an agent submits one prompt per turn. */
const KEPT = 8

export function createPromptWitness(): PromptWitness {
  const seen = new Map<string, { count: number; texts: string[] }>()
  return {
    heard(id, payload) {
      if (payload.hook_event_name !== 'UserPromptSubmit' || typeof payload.prompt !== 'string') return
      const entry = seen.get(id) ?? { count: 0, texts: [] }
      entry.count += 1
      entry.texts.push(payload.prompt)
      if (entry.texts.length > KEPT) entry.texts.shift()
      seen.set(id, entry)
    },
    mark: (id) => seen.get(id)?.count ?? 0,
    since(id, mark) {
      const entry = seen.get(id)
      if (!entry || entry.count <= mark) return []
      return entry.texts.slice(-Math.min(entry.count - mark, entry.texts.length))
    }
  }
}
