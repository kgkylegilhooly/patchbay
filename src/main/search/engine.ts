import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from '../../core/persist/atomicFile'
import { buildHandoff, type HandoffInput } from '../../core/search/handoff'
import { createSearchIndex, type SearchIndex } from '../../core/search/searchIndex'
import { transcriptEvents } from '../../core/search/transcriptEvents'
import type { HandoffDraft, IndexStats, SearchQuery, SearchResult, SyncInput } from '../../core/search/types'

/** What main asks of the search worker. Each is answered in order, one at a time. */
export type EngineRequest =
  | { type: 'sync'; input: SyncInput }
  | { type: 'search'; input: SyncInput; query: SearchQuery }
  | { type: 'rebuild'; input: SyncInput }
  | { type: 'stats' }
  | { type: 'handoff'; input: Omit<HandoffInput, 'transcript' | 'exists' | 'now'> }
  | { type: 'flush' }

export type EngineAnswer<R extends EngineRequest> = R extends { type: 'search' }
  ? SearchResult
  : R extends { type: 'handoff' }
    ? HandoffDraft
    : R extends { type: 'flush' }
      ? null
      : IndexStats

/** Saved a while after the last change, since an agent at work changes its transcript every few seconds. */
const SAVE_AFTER_MS = 15_000

function load(file: string | null): unknown {
  if (!file) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined // Missing or damaged: it's only a cache of the sources, so it's built again.
  }
}

/**
 * The search index and everything that reads files for it. It runs in a worker thread, so reading and parsing large
 * transcripts never holds up the main process or the window. Sources are only ever opened for reading; the one file
 * it writes is its own index.
 */
export function createSearchEngine(opts: { indexFile: string | null; now?: () => number }): { handle(r: EngineRequest): Promise<unknown> } {
  const now = opts.now ?? Date.now
  let index: SearchIndex = createSearchIndex(load(opts.indexFile))
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let queue: Promise<unknown> = Promise.resolve()

  const save = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!dirty || !opts.indexFile) return
    dirty = false
    await writeAtomic(opts.indexFile, JSON.stringify(index.toJSON())).catch((e: unknown) => console.error('Patchbay could not save the search index:', e))
  }
  const changed = (): void => {
    dirty = true
    if (!timer && opts.indexFile) {
      timer = setTimeout(() => void save(), SAVE_AFTER_MS)
      timer.unref?.()
    }
  }

  async function run(r: EngineRequest): Promise<unknown> {
    switch (r.type) {
      case 'sync':
        if (await index.sync(r.input)) changed()
        return index.stats()
      case 'search':
        if (await index.sync(r.input)) changed()
        return index.search(r.query)
      case 'rebuild':
        index = createSearchIndex()
        await index.sync(r.input)
        dirty = true
        await save()
        return index.stats()
      case 'stats':
        return index.stats()
      case 'handoff': {
        let transcript: HandoffInput['transcript']
        if (!r.input.transcriptPath) transcript = { missing: 'this conversation has no transcript yet' }
        else {
          try {
            transcript = transcriptEvents(await readFile(r.input.transcriptPath, 'utf8'))
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            transcript = { missing: code === 'ENOENT' ? 'the file is gone' : (e as Error).message }
          }
        }
        return buildHandoff({ ...r.input, transcript, exists: existsSync, now: now() })
      }
      case 'flush':
        await save()
        return null
    }
  }

  return {
    handle(r) {
      const next = queue.then(() => run(r))
      queue = next.catch(() => {})
      return next
    }
  }
}
