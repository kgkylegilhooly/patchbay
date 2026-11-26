import { stripAnsi } from '../core/transcript/read'

/**
 * F41: "Notify when it prints…". Waiting for "Compiled successfully", "Listening on" or an error in a run or terminal
 * meant watching it. A phrase, plain text and not a pattern, is looked for in each window's new output, with colours
 * gone and case ignored, once. Then it's forgotten.
 */

const MAX_PHRASE = 200
/** Raw output kept from the last chunk, so a phrase or a colour code split between two chunks is still found. */
const CARRY = 64

export type WatchResult = { ok: true; phrase: string } | { ok: false; reason: string }

export function createOutputWatch(d: { found: (nodeId: string, phrase: string) => void }) {
  const watches = new Map<string, { phrase: string; lower: string; tail: string }>()
  return {
    /** Starts watching for a phrase, replacing one already set for that window. */
    watch(nodeId: string, raw: string): WatchResult {
      const phrase = raw.replace(/\s+/g, ' ').trim()
      if (!phrase) return { ok: false, reason: 'Type the text to wait for.' }
      if (phrase.length > MAX_PHRASE) return { ok: false, reason: `That's longer than ${MAX_PHRASE} characters. A few words it will print are enough.` }
      watches.set(nodeId, { phrase, lower: phrase.toLowerCase(), tail: '' })
      return { ok: true, phrase }
    },
    cancel(nodeId: string): void {
      watches.delete(nodeId)
    },
    /** The phrase being waited for in this window, or null. */
    watching: (nodeId: string): string | null => watches.get(nodeId)?.phrase ?? null,
    /** New output from a window. */
    output(nodeId: string, data: string): void {
      const w = watches.get(nodeId)
      if (!w) return
      const seen = w.tail + data
      if (stripAnsi(seen).replace(/\s+/g, ' ').toLowerCase().includes(w.lower)) {
        watches.delete(nodeId)
        d.found(nodeId, w.phrase)
        return
      }
      w.tail = seen.slice(-(w.phrase.length + CARRY))
    }
  }
}

export type OutputWatch = ReturnType<typeof createOutputWatch>

/** pb:output:watch, :unwatch and :watches, for the app's own window only. Changes go out on pb:output:watchesChanged. */
export function serveOutputWatch(
  d: { watch: OutputWatch; store: { get(): { nodes: Array<{ id: string; kind: string }> } }; changed: (all: Record<string, string>) => void; ipc: { handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void } },
  isAppUi: (e: never) => boolean
): void {
  const all = (): Record<string, string> => Object.fromEntries(d.store.get().nodes.flatMap((n) => (d.watch.watching(n.id) ? [[n.id, d.watch.watching(n.id)!]] : [])))
  d.ipc.handle('pb:output:watch', (e, nodeId, phrase) => {
    if (!isAppUi(e as never) || typeof nodeId !== 'string' || typeof phrase !== 'string') return { ok: false, reason: 'Not allowed.' }
    const kind = d.store.get().nodes.find((n) => n.id === nodeId)?.kind
    if (kind !== 'terminal' && kind !== 'run') return { ok: false, reason: 'Only a terminal or run window can be watched for what it prints.' }
    const r = d.watch.watch(nodeId, phrase)
    if (r.ok) d.changed(all())
    return r
  })
  d.ipc.handle('pb:output:unwatch', (e, nodeId) => {
    if (!isAppUi(e as never) || typeof nodeId !== 'string') return
    d.watch.cancel(nodeId)
    d.changed(all())
  })
  d.ipc.handle('pb:output:watches', (e) => (isAppUi(e as never) ? all() : {}))
}
