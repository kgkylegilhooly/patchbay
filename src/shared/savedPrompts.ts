/**
 * F70, saved prompts: the asks a project uses again and again ("review this branch against main"), kept with the
 * project on the canvas, so they outlast Recent's 20 and never leave this PC. See renderer/RecentPromptsButton.tsx.
 */

export interface SavedPrompt {
  id: string
  /** What the menu shows: the prompt's first line that says something. */
  name: string
  text: string
  at: number
}

export const MAX_SAVED = 50
const MAX_TEXT = 8000
const MAX_NAME = 60

/** A prompt's first line that says something, squeezed and cut at a word. */
export function promptName(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim()
  if (line.length <= MAX_NAME) return line
  const cut = line.slice(0, MAX_NAME)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_NAME / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const isSaved = (p: unknown): p is SavedPrompt => {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o.id === 'string' && !!o.id && typeof o.name === 'string' && typeof o.text === 'string' && !!o.text.trim() && o.text.length <= MAX_TEXT && typeof o.at === 'number' && Number.isFinite(o.at)
}

/** The well-formed ones, at most MAX_SAVED, or undefined when there are none: damaged ones are dropped on their own. */
export function sanitizePrompts(raw: unknown): SavedPrompt[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const kept = raw.filter(isSaved).slice(0, MAX_SAVED).map((p) => ({ id: p.id, name: p.name.slice(0, MAX_NAME + 1), text: p.text, at: p.at }))
  return kept.length ? kept : undefined
}

/** The list with `text` saved first, named from its first line. The same text saved again moves up rather than twice. */
export function withPrompt(list: SavedPrompt[] | undefined, text: string, id: string, at: number): SavedPrompt[] {
  const t = text.trim()
  const now = list ?? []
  if (!t || t.length > MAX_TEXT) return now
  return [{ id, name: promptName(t), text: t, at }, ...now.filter((p) => p.text !== t)].slice(0, MAX_SAVED)
}

export function withoutPrompt(list: SavedPrompt[] | undefined, id: string): SavedPrompt[] {
  return (list ?? []).filter((p) => p.id !== id)
}
