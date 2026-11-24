import type { CanvasNode } from '../shared/model'
import type { FilesBridge } from '../shared/filesTouched'
import { confirmThen } from './shell/confirmStore'

/** Files named per agent, at most; the rest are counted. */
const SHOWN = 5
/** A check slower than this lets the close go ahead: a warning must never hold Close up. */
const CHECK_MS = 2000

/**
 * What to say before closing agents that left edits uncommitted, or null when none did. Only the files each one edited
 * itself count, so another agent's work in the same checkout doesn't raise it.
 */
export function uncommittedQuestion(found: Array<{ title: string; files: string[] }>): { message: string; lines: string[] } | null {
  const left = found.filter((f) => f.files.length)
  if (!left.length) return null
  const lines = left.map(({ title, files }) => {
    const named = files.slice(0, SHOWN).join(', ')
    const more = files.length > SHOWN ? ` and ${files.length - SHOWN} more` : ''
    return `${title} left ${files.length} file${files.length === 1 ? '' : 's'} it edited uncommitted: ${named}${more}.`
  })
  return { message: 'Closing keeps the files as they are, but nothing will remind anyone to commit them.', lines }
}

/**
 * Closes, first asking when an agent among them left edits uncommitted. Anything else, or a check that fails or is
 * slow, closes straight away.
 */
export async function closeGuarded(ids: string[], nodes: CanvasNode[], close: (ids: string[]) => void, files: Pick<FilesBridge, 'uncommitted'> | undefined): Promise<void> {
  const agents = nodes.filter((n) => ids.includes(n.id) && n.kind === 'claude')
  if (!agents.length || !files) return close(ids)
  const look = Promise.all(agents.map(async (a) => ({ title: a.title, files: await files.uncommitted(a.id).catch(() => [] as string[]) })))
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), CHECK_MS))
  const found = await Promise.race([look, timeout])
  const question = found ? uncommittedQuestion(found) : null
  if (!question) return close(ids)
  void confirmThen(
    { title: ids.length === 1 ? 'Close window?' : 'Close windows?', ...question, verb: 'Close anyway', cancelLabel: 'Keep', tone: 'danger', icon: 'close', attrs: { 'data-confirm': 'close-uncommitted' } },
    () => close(ids)
  )
}
