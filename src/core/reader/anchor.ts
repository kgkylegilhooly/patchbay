import type { CommentAnchor } from '../../shared/reader'
import { normalizeText, type DocOutline } from './outline'

/** The longest quote kept. A longer selection keeps its start, which still finds the place. */
export const MAX_QUOTE = 500

/** A quote as stored: whitespace collapsed and cut to MAX_QUOTE, never mid-way through a surrogate pair. */
export function quoteOf(text: string): string {
  const q = normalizeText(text)
  if (q.length <= MAX_QUOTE) return q
  const cut = /[\uD800-\uDBFF]/.test(q[MAX_QUOTE - 1]) ? MAX_QUOTE - 1 : MAX_QUOTE
  return q.slice(0, cut).trimEnd()
}

/**
 * Text as it's compared: without any whitespace. The page and the Markdown source put spaces between blocks, table
 * cells and tags differently, and the words are what matter.
 */
export function matchKey(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, '')
}

/** Where a comment lands in the document as it is now. */
export type Placement =
  /** Found. `moved` when it's no longer under the headings it was written under. */
  | { state: 'anchored'; section: number; moved: boolean }
  /** Its quote is gone from the document. */
  | { state: 'outdated' }
  /** A comment on the whole document. */
  | { state: 'document' }

const samePath = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])

/**
 * Finds a comment's place: its quote in a section with the same headings, else in any section (the heading was renamed
 * or the text moved), else running across sections, which lands it where the quote starts. Otherwise it's outdated.
 */
export function place(anchor: CommentAnchor | null, doc: DocOutline): Placement {
  if (!anchor) return { state: 'document' }
  const quote = matchKey(anchor.quote)
  if (!quote) {
    // A comment on an empty heading or block: the headings alone place it.
    const same = doc.sections.find((s) => samePath(s.path, anchor.section))
    return same ? { state: 'anchored', section: same.index, moved: false } : { state: 'outdated' }
  }
  const keys = doc.sections.map((s) => matchKey(s.text))
  const home = doc.sections.find((s, i) => samePath(s.path, anchor.section) && keys[i].includes(quote))
  if (home) return { state: 'anchored', section: home.index, moved: false }
  const elsewhere = doc.sections.find((_s, i) => keys[i].includes(quote))
  if (elsewhere) return { state: 'anchored', section: elsewhere.index, moved: true }
  const at = keys.join('').indexOf(quote)
  if (at < 0) return { state: 'outdated' }
  let end = 0
  for (const s of doc.sections) {
    end += keys[s.index].length
    if (at < end) return { state: 'anchored', section: s.index, moved: !samePath(s.path, anchor.section) }
  }
  return { state: 'outdated' }
}

/** A section's headings as the person reads them: Rollout > Phase 2. */
export function sectionLabel(path: string[]): string {
  return path.length ? path.join(' > ') : 'the start of the document'
}
