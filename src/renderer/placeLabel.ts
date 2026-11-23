import { shortPath } from './shortPath'

const parts = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)

/**
 * A session's folder as a sidebar row shows it, short and with the part that tells folders apart: inside its project's
 * folder, the path from there; in a worktree Patchbay made (`<repo>-worktrees\<branch>`), the worktree's own folder
 * on, such as "dark-mode"; elsewhere the last two folders. The full path goes in the row's tooltip.
 */
export function placeLabel(where: string, projectFolder?: string | null): string {
  if (!where || /^ssh /.test(where)) return where
  const segs = parts(where)
  const at = segs.findIndex((s, i) => i < segs.length - 1 && /-worktrees$/i.test(s))
  if (at !== -1) return segs.slice(at + 1).join(where.includes('\\') ? '\\' : '/')
  return shortPath(where, projectFolder)
}
