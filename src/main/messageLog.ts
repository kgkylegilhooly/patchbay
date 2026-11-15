import { readIfPresentSync, writeAtomic } from '../core/persist/atomicFile'
import type { NodeMessage } from '../shared/contract'

/** Messages kept, newest last. Older ones go first. */
const KEPT = 300
/** Enough to see what was asked. The whole text is in the receiving node's own conversation or terminal. */
const TEXT_CHARS = 2000
/** Messages often come in bursts, so they're written a moment after the last one. */
const SAVE_AFTER_MS = 2000

export interface MessageLog {
  add(from: string, to: string, text: string, at?: number): NodeMessage
  all(): NodeMessage[]
  /** Writes what's waiting to be saved, as when the app quits. */
  flush(): Promise<void>
}

const isMessage = (v: unknown): v is NodeMessage => {
  const m = v as Record<string, unknown>
  return typeof m === 'object' && m !== null && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.text === 'string' && typeof m.at === 'number'
}

/** What a save file holds, or nothing if it's missing or damaged. Losing old messages is better than not starting. */
function load(file: string | undefined): NodeMessage[] {
  if (!file) return []
  try {
    const parsed: unknown = JSON.parse(readIfPresentSync(file) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isMessage).slice(-KEPT) : []
  } catch {
    return []
  }
}

/**
 * What nodes have sent each other with `patchbay send`, for the person to look back on from the cable between them.
 * With a file, it's kept across restarts.
 */
export function createMessageLog(file?: string): MessageLog {
  const kept: NodeMessage[] = load(file)
  let timer: NodeJS.Timeout | null = null
  const save = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (file) await writeAtomic(file, JSON.stringify(kept)).catch((e: unknown) => console.error('Patchbay could not save messages:', e))
  }
  return {
    add(from, to, text, at = Date.now()) {
      const message = { from, to, text: text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text, at }
      kept.push(message)
      if (kept.length > KEPT) kept.splice(0, kept.length - KEPT)
      if (file && !timer) {
        timer = setTimeout(() => void save(), SAVE_AFTER_MS)
        timer.unref?.()
      }
      return message
    },
    all: () => [...kept],
    flush: () => (timer ? save() : Promise.resolve())
  }
}
