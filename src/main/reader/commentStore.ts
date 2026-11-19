import { join } from 'node:path'
import { readIfPresentSync, writeAtomic } from '../../core/persist/atomicFile'
import { isComment, MAX_COMMENTS } from '../../core/reader/comments'
import type { ReaderComment } from '../../shared/reader'
import { docKey } from './policy'

/** At most this many documents keep comments. The ones touched longest ago go first. */
export const MAX_DOCS = 400

interface Entry {
  path: string
  updatedAt: number
  comments: ReaderComment[]
}

export interface CommentStore {
  get(path: string): ReaderComment[]
  set(path: string, comments: ReaderComment[]): Promise<void>
  /** Saved comments couldn't be read at start-up. They're kept aside, not overwritten. */
  readonly loadProblem: string | null
}

/**
 * Comments on documents, kept per file (by its resolved, case-folded path) in `<dir>/comments.json`, apart from the
 * canvas, so they outlive the reader node. Writes are atomic and one at a time.
 */
export function createCommentStore(dir: string, now: () => number = Date.now): CommentStore {
  const file = join(dir, 'comments.json')
  const docs = new Map<string, Entry>()
  let loadProblem: string | null = null
  let writing: Promise<void> = Promise.resolve()

  try {
    const text = readIfPresentSync(file)
    if (text) {
      const parsed = JSON.parse(text) as { docs?: Record<string, Entry> }
      for (const [key, e] of Object.entries(parsed.docs ?? {})) {
        if (typeof e?.path !== 'string' || !Array.isArray(e.comments)) continue
        docs.set(key, { path: e.path, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0, comments: e.comments.filter(isComment).slice(0, MAX_COMMENTS) })
      }
    }
  } catch (e) {
    loadProblem = `Saved reader comments couldn't be read: ${(e as Error).message}`
  }

  const save = (): Promise<void> => {
    // A file that couldn't be read is left as it was, so nothing in it is lost to a save.
    if (loadProblem) return Promise.resolve()
    const body = JSON.stringify({ version: 1, docs: Object.fromEntries(docs) })
    writing = writing.then(() => writeAtomic(file, body)).catch((e: unknown) => console.error('Patchbay could not save reader comments:', e))
    return writing
  }

  return {
    get loadProblem() {
      return loadProblem
    },
    get(path) {
      return docs.get(docKey(path))?.comments ?? []
    },
    set(path, comments) {
      const key = docKey(path)
      const kept = comments.filter(isComment).slice(0, MAX_COMMENTS)
      if (kept.length) docs.set(key, { path, updatedAt: now(), comments: kept })
      else docs.delete(key)
      if (docs.size > MAX_DOCS) {
        const oldest = [...docs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, docs.size - MAX_DOCS)
        for (const [k] of oldest) docs.delete(k)
      }
      return save()
    }
  }
}
