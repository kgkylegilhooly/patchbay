import type { CommentAnchor, ReaderComment } from '../../shared/reader'
import { place, sectionLabel } from './anchor'
import type { DocOutline } from './outline'

/** The most comments one document keeps, so a runaway can't grow the file without end. */
export const MAX_COMMENTS = 500
/** The longest comment text kept. */
export const MAX_COMMENT_CHARS = 8000

export function addComment(list: ReaderComment[], c: { id: string; anchor: CommentAnchor | null; text: string; at: number }): ReaderComment[] {
  const text = c.text.trim().slice(0, MAX_COMMENT_CHARS)
  if (!text || list.length >= MAX_COMMENTS) return list
  return [...list, { id: c.id, anchor: c.anchor, text, createdAt: c.at, resolved: false }]
}

/** Changing what it says means the agent hasn't seen it: it goes again with the next send. */
export function editComment(list: ReaderComment[], id: string, text: string): ReaderComment[] {
  const t = text.trim().slice(0, MAX_COMMENT_CHARS)
  if (!t) return list
  return list.map((c) => (c.id === id && c.text !== t ? withoutSent({ ...c, text: t }) : c))
}

export function resolveComment(list: ReaderComment[], id: string): ReaderComment[] {
  return list.map((c) => (c.id === id ? { ...c, resolved: true } : c))
}

/** Reopening says it isn't dealt with, so it goes again with the next send. */
export function reopenComment(list: ReaderComment[], id: string): ReaderComment[] {
  return list.map((c) => (c.id === id ? withoutSent({ ...c, resolved: false }) : c))
}

export function removeComment(list: ReaderComment[], id: string): ReaderComment[] {
  return list.filter((c) => c.id !== id)
}

function withoutSent(c: ReaderComment): ReaderComment {
  const { sent: _sent, ...rest } = c
  return rest
}

/** What Send covers: open comments the agent hasn't had yet. */
export function unsent(list: ReaderComment[]): ReaderComment[] {
  return list.filter((c) => !c.resolved && !c.sent)
}

export function markSent(list: ReaderComment[], ids: string[], to: string, at: number, queued = false): ReaderComment[] {
  const sending = new Set(ids)
  return list.map((c) => (sending.has(c.id) ? { ...c, sent: { at, to, ...(queued ? { queued } : {}) } } : c))
}

/**
 * Comments in reading order: the whole-document ones first, then by where they land, then outdated ones, each group
 * oldest first.
 */
export function inReadingOrder(list: ReaderComment[], doc: DocOutline): ReaderComment[] {
  const rank = (c: ReaderComment): number => {
    const p = place(c.anchor, doc)
    return p.state === 'document' ? -1 : p.state === 'anchored' ? p.section : Number.MAX_SAFE_INTEGER
  }
  return list
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.c.createdAt - b.c.createdAt || a.i - b.i)
    .map((x) => x.c)
}

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim()

const QUOTE_SHOWN = 300

/**
 * One message with every comment, numbered, each with where it is and the words it's on, so the agent can find it in
 * the file. The file is named in full since the agent may not have it open.
 */
export function formatComments(a: { title: string; path: string; comments: ReaderComment[]; doc: DocOutline }): string {
  const parts = [`Comments on "${a.title}" (${a.path}). Please address each one, then say what you changed.`, '']
  inReadingOrder(a.comments, a.doc).forEach((c, i) => {
    const n = `${i + 1}.`
    const pad = ' '.repeat(n.length + 1)
    const p = place(c.anchor, a.doc)
    if (!c.anchor || p.state === 'document') {
      parts.push(`${n} On the whole document:`)
    } else {
      const section = p.state === 'anchored' ? a.doc.sections[p.section].path : c.anchor.section
      const quote = c.anchor.quote.length > QUOTE_SHOWN ? `${c.anchor.quote.slice(0, QUOTE_SHOWN)}…` : c.anchor.quote
      const where = section.length ? `In "${sectionLabel(section)}"` : 'At the start of the document'
      const on = quote ? `, on: "${quote}"` : ''
      const gone = p.state === 'outdated' ? ' (this text is no longer in the file)' : ''
      parts.push(`${n} ${where}${on}${gone}`)
    }
    for (const line of c.text.split(/\r?\n/)) if (line.trim()) parts.push(`${pad}${oneLine(line)}`)
  })
  return parts.join('\n')
}

/** Whether a stored list is well formed. Anything else in the file is dropped rather than shown. */
export function isComment(c: unknown): c is ReaderComment {
  if (typeof c !== 'object' || c === null) return false
  const x = c as Record<string, unknown>
  const anchorOk =
    x.anchor === null ||
    (typeof x.anchor === 'object' &&
      x.anchor !== null &&
      Array.isArray((x.anchor as CommentAnchor).section) &&
      (x.anchor as CommentAnchor).section.every((s) => typeof s === 'string') &&
      typeof (x.anchor as CommentAnchor).quote === 'string')
  const sentOk =
    x.sent === undefined || (typeof x.sent === 'object' && x.sent !== null && typeof (x.sent as { at: unknown }).at === 'number' && typeof (x.sent as { to: unknown }).to === 'string')
  return typeof x.id === 'string' && anchorOk && typeof x.text === 'string' && typeof x.createdAt === 'number' && typeof x.resolved === 'boolean' && sentOk
}
