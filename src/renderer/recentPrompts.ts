/**
 * Prompts the person started agents with or sent to them, newest first, on this PC only. A brief retyped into every
 * new agent ("run the tests and fix what fails") is then one pick away. See RecentPrompts.tsx.
 */

const KEY = 'patchbay.recentPrompts'
export const KEEP_PROMPTS = 20
/** Longer than any brief worth picking again, and small enough for the browser's own storage. */
const MAX_CHARS = 8000
const LABEL_MAX = 60

/** The list with `text` added first: trimmed, once only, and no more than KEEP_PROMPTS. The same list for blank text. */
export function remembered(list: string[], text: string): string[] {
  const t = text.trim()
  if (!t || t.length > MAX_CHARS) return list
  return [t, ...list.filter((p) => p !== t)].slice(0, KEEP_PROMPTS)
}

/** A prompt as a menu row: its first line that says something, squeezed and cut at a word. */
export function promptLabel(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim()
  if (line.length <= LABEL_MAX) return line
  const cut = line.slice(0, LABEL_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > LABEL_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function recentPrompts(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string').slice(0, KEEP_PROMPTS) : []
  } catch {
    return []
  }
}

export function rememberPrompt(text: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(remembered(recentPrompts(), text)))
  } catch {
    // A list of past prompts isn't worth interrupting anyone over.
  }
}
