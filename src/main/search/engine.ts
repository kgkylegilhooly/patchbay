import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeAtomic } from '../../core/persist/atomicFile'
import { buildHandoff, type HandoffInput } from '../../core/search/handoff'
import { createSearchIndex, INDEX_VERSION, type SearchIndex } from '../../core/search/searchIndex'
import { transcriptEvents } from '../../core/search/transcriptEvents'
import type { HandoffDraft, IndexStats, SearchQuery, SearchResult, SourceWindow, SyncInput } from '../../core/search/types'

/** What main asks of the search worker. */
export type EngineRequest =
  | { type: 'sync'; input: SyncInput }
  | { type: 'search'; input: SyncInput; query: SearchQuery }
  | { type: 'rebuild'; input: SyncInput }
  | { type: 'stats' }
  | { type: 'source'; key: string; around: number; before: number; after: number }
  | { type: 'handoff'; input: Omit<HandoffInput, 'transcript' | 'exists' | 'now'> }
  | { type: 'flush' }

export type EngineAnswer<R extends EngineRequest> = R extends { type: 'search' }
  ? SearchResult
  : R extends { type: 'handoff' }
    ? HandoffDraft
    : R extends { type: 'source' }
      ? SourceWindow | null
      : R extends { type: 'flush' }
        ? null
        : IndexStats

/**
 * The index is a copy of every conversation's text, so it's saved rarely: agents change their transcripts every few
 * seconds, and writing it all each time was disk churn for nothing. It's saved at quit as well. When a source was
 * dropped, as when a transcript was deleted, it's saved soon, so the copy doesn't outlast the original for long.
 */
const SAVE_AFTER_MS = 5 * 60_000
const SAVE_AFTER_REMOVAL_MS = 15_000
/** A search right after a sync answers from the index as it is, without looking at the files again. */
const FRESH_MS = 10_000
/** The most messages one source request returns. */
const MAX_WINDOW = 200

/** What the canvas says search should hold, without transcripts' contents: if it differs, a sync is due at once. */
function signature(input: SyncInput): string {
  const parts = input.sources.map((s) => `${s.key}|${JSON.stringify(s.ref)}|${s.title}|${s.projectId ?? ''}|${'text' in s ? `${s.text.length}:${s.text.slice(0, 64)}` : s.path}`)
  return `${parts.join('\n')}\n${JSON.stringify(input.projects)}`
}

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
 *
 * Syncs run one at a time. Searches never wait for one: while a sync is running, a search answers from the index as
 * it stands, and its stats say it's still syncing.
 */
export function createSearchEngine(opts: { indexFile: string | null; now?: () => number }): { handle(r: EngineRequest): Promise<unknown> } {
  const now = opts.now ?? Date.now
  let index: SearchIndex = createSearchIndex(load(opts.indexFile))
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerAt = Infinity
  let dirty = false
  let chain: Promise<unknown> = Promise.resolve()
  let running = 0
  let lastSync = -Infinity
  let lastSigned = ''

  const save = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    timerAt = Infinity
    if (!dirty || !opts.indexFile) return
    dirty = false
    await writeAtomic(opts.indexFile, JSON.stringify(index.toJSON())).catch((e: unknown) => console.error('Patchbay could not save the search index:', e))
  }
  const changed = (removed: number): void => {
    dirty = true
    if (!opts.indexFile) return
    const at = now() + (removed ? SAVE_AFTER_REMOVAL_MS : SAVE_AFTER_MS)
    if (at >= timerAt) return
    if (timer) clearTimeout(timer)
    timerAt = at
    timer = setTimeout(() => void save(), at - now())
    timer.unref?.()
  }

  /** Queues a sync behind any running one. `fresh` starts from an empty index, keeping only project names. */
  const sync = (input: SyncInput, fresh = false): Promise<IndexStats> => {
    running++
    const next = chain.then(async () => {
      try {
        if (fresh) {
          index = createSearchIndex({ version: INDEX_VERSION, docs: [], projects: index.toJSON().projects })
          dirty = true
        }
        const signed = signature(input)
        const r = await index.sync(input)
        lastSigned = signed
        if (r.changed) changed(r.removed)
        lastSync = now()
        if (fresh) await save()
        return index.stats()
      } finally {
        running--
      }
    })
    chain = next.catch(() => {})
    return next
  }

  /** Syncing covers a sync still waiting its turn, not only the one reading files now. */
  const stats = (): IndexStats => ({ ...index.stats(), syncing: running > 0 })

  async function handoff(input: Extract<EngineRequest, { type: 'handoff' }>['input']): Promise<HandoffDraft> {
    let transcript: HandoffInput['transcript']
    if (!input.transcriptPath) transcript = { missing: 'this conversation has no transcript yet' }
    else {
      try {
        transcript = transcriptEvents(await readFile(input.transcriptPath, 'utf8'))
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        transcript = { missing: code === 'ENOENT' ? 'the file is gone' : (e as Error).message }
      }
    }
    return buildHandoff({ ...input, transcript, exists: existsSync, now: now() })
  }

  function source(r: Extract<EngineRequest, { type: 'source' }>): SourceWindow | null {
    const doc = index.doc(r.key)
    if (!doc) return null
    const total = doc.entries.length
    const focus = Math.min(Math.max(0, Math.floor(r.around) || 0), Math.max(0, total - 1))
    const before = Math.min(Math.max(0, Math.floor(r.before) || 0), MAX_WINDOW)
    const after = Math.min(Math.max(0, Math.floor(r.after) || 0), MAX_WINDOW - before)
    const start = Math.max(0, focus - before)
    return { title: doc.title, kind: doc.kind, start, entries: doc.entries.slice(start, Math.min(total, focus + after + 1)), total, focus }
  }

  return {
    async handle(r) {
      switch (r.type) {
        case 'sync':
          return sync(r.input)
        case 'search':
          // Only when nothing is syncing: a search must never queue behind a long first sync or a rebuild.
          // Transcripts are looked at again once the last sync is stale; a change on the canvas, at once.
          if (running === 0 && (now() - lastSync > FRESH_MS || signature(r.input) !== lastSigned)) await sync(r.input)
          return { ...index.search(r.query), stats: stats() }
        case 'rebuild':
          return sync(r.input, true)
        case 'stats':
          return stats()
        case 'source':
          return source(r)
        case 'handoff':
          return handoff(r.input)
        case 'flush':
          await chain
          await save()
          return null
      }
    }
  }
}
