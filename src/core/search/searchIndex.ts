import { readAdded } from './fileTail'
import { createEventReader } from './transcriptEvents'
import type { ConversationSpec, IndexedDoc, IndexStats, SearchEntry, SearchHit, SearchQuery, SearchResult, SyncInput } from './types'

/** Bumped when what's saved changes shape. An index saved by another version is thrown away and built again. */
export const INDEX_VERSION = 1
/** A message longer than this is cut for the index. The whole of it is still in the transcript. */
const ENTRY_CHARS = 20000
const DEFAULT_LIMIT = 50
const SNIPPET_BEFORE = 70
const SNIPPET_AFTER = 170

export interface SavedIndex {
  version: number
  docs: IndexedDoc[]
  projects: Record<string, string>
}

/** The words of a query, lowercased. A "quoted phrase" stays one term. */
export function queryTerms(text: string): string[] {
  const terms: string[] = []
  for (const m of text.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (m[1] ?? m[2]).trim().replace(/\s+/g, ' ')
    if (term && !terms.includes(term)) terms.push(term)
  }
  return terms
}

const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** Text around the first match, with every term marked in it. Whitespace runs become single spaces. */
export function snippetOf(text: string, terms: string[]): { snippet: string; marks: Array<[number, number]> } {
  const plain = flat(text)
  const low = plain.toLowerCase()
  const first = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i !== -1), plain.length)
  const start = Math.max(0, first - SNIPPET_BEFORE)
  const end = Math.min(plain.length, first + SNIPPET_AFTER)
  const lead = start > 0 ? '…' : ''
  const snippet = `${lead}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`
  const lowSnippet = snippet.toLowerCase()
  const marks: Array<[number, number]> = []
  for (const term of terms) {
    for (let at = lowSnippet.indexOf(term); at !== -1; at = lowSnippet.indexOf(term, at + term.length)) marks.push([at, at + term.length])
  }
  marks.sort((a, b) => a[0] - b[0])
  // Overlapping terms make one mark.
  const merged: Array<[number, number]> = []
  for (const m of marks) {
    const last = merged[merged.length - 1]
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1])
    else merged.push([m[0], m[1]])
  }
  return { snippet, marks: merged }
}

const cut = (text: string): string => (text.length > ENTRY_CHARS ? `${text.slice(0, ENTRY_CHARS)}…` : text)

function isSaved(v: unknown): v is SavedIndex {
  const s = v as SavedIndex
  return typeof s === 'object' && s !== null && s.version === INDEX_VERSION && Array.isArray(s.docs) && typeof s.projects === 'object' && s.projects !== null
}

export interface SearchIndex {
  /** Brings the index up to date with the sources: reads what transcripts added, drops what's gone. Says whether anything changed. */
  sync(input: SyncInput): Promise<boolean>
  search(query: SearchQuery): SearchResult
  stats(): IndexStats
  doc(key: string): IndexedDoc | undefined
  /** Forgets everything, so the next sync reads every source from the start. */
  clear(): void
  toJSON(): SavedIndex
}

/** The search index. Pass what toJSON saved to start from it; anything unreadable starts empty. */
export function createSearchIndex(saved?: unknown): SearchIndex {
  const docs = new Map<string, IndexedDoc>()
  let projects: Record<string, string> = {}
  if (isSaved(saved)) {
    for (const d of saved.docs) if (d && typeof d.key === 'string' && Array.isArray(d.entries)) docs.set(d.key, d)
    projects = { ...saved.projects }
  }
  let current: Set<string> = new Set()
  let missing = 0
  let syncedAt: number | null = null
  let syncing = false
  const lower = new WeakMap<SearchEntry, string>()
  const lowered = (e: SearchEntry): string => {
    let l = lower.get(e)
    if (l === undefined) lower.set(e, (l = e.text.toLowerCase()))
    return l
  }

  async function syncConversation(spec: ConversationSpec): Promise<'changed' | 'same' | 'missing' | 'unreadable'> {
    const before = docs.get(spec.key)
    // A transcript moved to another path is a different file.
    const cursor = before?.path === spec.path ? before.cursor : undefined
    const added: SearchEntry[] = []
    const reader = createEventReader()
    let result
    try {
      result = await readAdded(spec.path, cursor, (text) => {
        for (const line of text.split('\n')) {
          for (const e of reader.line(line)) if (e.kind === 'message') added.push({ text: cut(e.text), role: e.role, ...(e.at !== undefined ? { at: e.at } : {}) })
        }
      })
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
    }
    const entries = result.fromStart || !before ? added : added.length ? [...before.entries, ...added] : before.entries
    const lastAt = entries.reduce<number | undefined>((m, e) => (e.at !== undefined && (m === undefined || e.at > m) ? e.at : m), undefined)
    const next: IndexedDoc = {
      key: spec.key,
      kind: 'conversation',
      title: spec.title,
      ref: spec.ref,
      path: spec.path,
      at: lastAt ?? spec.at ?? before?.at ?? 0,
      entries,
      cursor: result.cursor,
      ...(spec.projectId ? { projectId: spec.projectId } : {}),
      ...(spec.agent ? { agent: spec.agent } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {})
    }
    const same =
      before &&
      entries === before.entries &&
      before.title === next.title &&
      before.projectId === next.projectId &&
      JSON.stringify(before.ref) === JSON.stringify(next.ref) &&
      before.cursor?.offset === next.cursor?.offset
    docs.set(spec.key, same ? { ...next, entries: before.entries } : next)
    return same ? 'same' : 'changed'
  }

  return {
    async sync(input) {
      syncing = true
      try {
        let changed = false
        for (const [id, name] of Object.entries(input.projects)) {
          if (projects[id] !== name) {
            projects[id] = name
            changed = true
          }
        }
        const seen = new Set<string>()
        let gone = 0
        for (const spec of input.sources) {
          if (seen.has(spec.key)) continue
          if (!('text' in spec)) {
            const outcome = await syncConversation(spec)
            if (outcome === 'missing') {
              gone++
              continue
            }
            seen.add(spec.key)
            // Unreadable for now, as when Windows has it locked: what was indexed stays until it can be read again.
            if (outcome === 'changed') changed = true
            continue
          }
          seen.add(spec.key)
          const before = docs.get(spec.key)
          const text = cut(spec.text)
          if (before && before.entries[0]?.text === text && before.title === spec.title && before.projectId === spec.projectId && JSON.stringify(before.ref) === JSON.stringify(spec.ref)) continue
          docs.set(spec.key, { key: spec.key, kind: spec.kind, title: spec.title, ref: spec.ref, at: spec.at, entries: [{ text, at: spec.at }], ...(spec.projectId ? { projectId: spec.projectId } : {}) })
          changed = true
        }
        for (const key of [...docs.keys()]) {
          if (!seen.has(key)) {
            docs.delete(key)
            changed = true
          }
        }
        current = new Set(Object.keys(input.projects))
        missing = gone
        syncedAt = Date.now()
        return changed
      } finally {
        syncing = false
      }
    },

    search(query) {
      const terms = queryTerms(query.text)
      const limit = query.limit ?? DEFAULT_LIMIT
      const hits: SearchHit[] = []
      if (terms.length === 0) return { hits, stats: this.stats(), more: false }
      const kinds = query.kinds?.length ? new Set(query.kinds) : null
      const inRange = (at: number): boolean => (query.from === undefined || at >= query.from) && (query.to === undefined || at <= query.to)
      for (const doc of docs.values()) {
        if (query.projectId !== undefined && doc.projectId !== query.projectId) continue
        if (kinds && !kinds.has(doc.kind)) continue
        let best: SearchEntry | null = null
        let matches = 0
        for (const entry of doc.entries) {
          if (!inRange(entry.at ?? doc.at)) continue
          const text = lowered(entry)
          if (!terms.every((t) => text.includes(t))) continue
          matches++
          if (!best || (entry.at ?? 0) >= (best.at ?? 0)) best = entry
        }
        // A conversation found by its title, when no one message has every word.
        if (!best && inRange(doc.at) && terms.every((t) => doc.title.toLowerCase().includes(t))) best = { text: doc.title, at: doc.at }
        if (!best) continue
        const { snippet, marks } = snippetOf(best.text, terms)
        const name = doc.projectId ? projects[doc.projectId] : undefined
        hits.push({
          key: doc.key,
          kind: doc.kind,
          title: doc.title,
          ref: doc.ref,
          at: best.at ?? doc.at,
          snippet,
          marks,
          matches,
          ...(doc.projectId ? { projectId: doc.projectId } : {}),
          ...(name !== undefined ? { projectName: name } : {}),
          ...(doc.projectId && syncedAt !== null && !current.has(doc.projectId) ? { projectGone: true } : {}),
          ...(doc.agent ? { agent: doc.agent } : {}),
          ...(best.role ? { role: best.role } : {})
        })
      }
      hits.sort((a, b) => b.at - a.at || b.matches - a.matches)
      return { hits: hits.slice(0, limit), stats: this.stats(), more: hits.length > limit }
    },

    stats() {
      const count = { conversations: 0, notes: 0, messages: 0, other: 0 }
      for (const d of docs.values()) {
        if (d.kind === 'conversation') count.conversations++
        else if (d.kind === 'note') count.notes++
        else if (d.kind === 'message') count.messages++
        else count.other++
      }
      return { ...count, missing, syncedAt, syncing }
    },

    doc: (key) => docs.get(key),

    clear() {
      docs.clear()
      syncedAt = null
    },

    toJSON: () => ({ version: INDEX_VERSION, docs: [...docs.values()], projects: { ...projects } })
  }
}
