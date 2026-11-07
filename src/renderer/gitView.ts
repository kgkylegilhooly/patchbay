import type { ChangeEntry, RepoStatus } from '../shared/git'
import { isSessionNode, type CanvasDoc } from '../shared/model'

/**
 * Folders the git panel can offer, best first: what's selected, then the project's own folder, its worktree groups,
 * and the folders its sessions run in. Main works out which repository each is in.
 */
export function repoCandidates(doc: CanvasDoc, selected: string[]): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = []
  const add = (path: string | undefined, label: string): void => {
    if (path && !out.some((o) => o.path.toLowerCase() === path.toLowerCase())) out.push({ path, label })
  }
  const here = doc.nodes.filter((n) => n.projectId === doc.activeProjectId)
  for (const id of selected) {
    const n = here.find((x) => x.id === id)
    if (n?.kind === 'group' && n.worktree) add(n.worktree.path, `Worktree: ${n.worktree.branch}`)
    else if (isSessionNode(n)) add(n.cwd, `Session: ${n.title}`)
  }
  add(doc.projects.find((p) => p.id === doc.activeProjectId)?.folder, 'Project folder')
  for (const n of here) if (n.kind === 'group' && n.worktree) add(n.worktree.path, `Worktree: ${n.worktree.branch}`)
  for (const n of here) if (isSessionNode(n)) add(n.cwd, `Session: ${n.title}`)
  return out
}

const list = (paths: string[]): string => {
  const shown = paths.slice(0, 4).join(', ')
  return paths.length > 4 ? `${shown} and ${paths.length - 4} more` : shown
}

/** Says exactly what discarding loses, naming untracked files separately because they're deleted outright. */
export function discardWarning(entries: ChangeEntry[]): string {
  const tracked = entries.filter((e) => e.area === 'unstaged').map((e) => e.path)
  const untracked = entries.filter((e) => e.area === 'untracked').map((e) => e.path)
  const parts: string[] = []
  if (tracked.length) parts.push(`Throws away your unstaged changes to ${tracked.length === 1 ? '1 file' : `${tracked.length} files`} (${list(tracked)}), putting back what's staged or committed.`)
  if (untracked.length) parts.push(`Deletes ${untracked.length === 1 ? '1 untracked file' : `${untracked.length} untracked files`} (${list(untracked)}) from disk.`)
  return `${parts.join(' ')} This can't be undone.`
}

/** Tracked changes that a branch switch would have to carry over, or that git would refuse to overwrite. */
export function uncommittedCount(s: RepoStatus): number {
  return new Set([...s.staged, ...s.unstaged.filter((e) => e.area === 'unstaged'), ...s.conflicts].map((e) => e.path)).size
}

export function switchWarning(s: RepoStatus, branch: string): string | null {
  const n = uncommittedCount(s)
  if (n === 0) return null
  return `You have ${n === 1 ? '1 file' : `${n} files`} with uncommitted changes. Switching to ${branch} carries them over when git can; if they would be overwritten, git refuses and nothing changes. Commit or discard first to be sure.`
}

/** A ref from `git log %D`, as a chip: which kind, and its name. */
export function refChip(ref: string, remoteBranches: Set<string>): { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string } {
  if (ref.startsWith('HEAD -> ')) return { kind: 'head', name: ref.slice(8) }
  if (ref === 'HEAD') return { kind: 'head', name: 'HEAD' }
  if (ref.startsWith('tag: ')) return { kind: 'tag', name: ref.slice(5) }
  return { kind: remoteBranches.has(ref) ? 'remote' : 'branch', name: ref }
}
