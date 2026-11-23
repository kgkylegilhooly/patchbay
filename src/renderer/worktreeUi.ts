import { create } from 'zustand'
import type { MenuEntry } from './menus'
import { askConfirm, namedQuestion } from './shell/confirmStore'

/**
 * Removing a group's worktree, from wherever it's asked for: the group's ⋯ menu or its right-click menu. It always
 * asks first, and a refusal (uncommitted changes, say) shows on the group's header until the next try.
 */
export const useWorktreeErrors = create<Record<string, string | undefined>>(() => ({}))

function message(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
}

export async function askRemoveWorktree(groupId: string, branch?: string): Promise<void> {
  const ok = await askConfirm({
    title: namedQuestion('Remove worktree', branch) ?? 'Remove this worktree?',
    message: "Deletes the worktree's folder, including git-ignored files. Sessions in it stop. The branch stays.",
    verb: 'Remove worktree',
    cancelLabel: 'Keep',
    attrs: { 'data-wt-confirm': groupId }
  })
  if (!ok) return
  useWorktreeErrors.setState({ [groupId]: undefined })
  try {
    // Read when used, not at import, so the menus that offer this load without a window (as in tests).
    const r = await window.patchbay.removeWorktree(groupId)
    if (!r.ok) useWorktreeErrors.setState({ [groupId]: r.reason })
  } catch (e) {
    useWorktreeErrors.setState({ [groupId]: message(e) })
  }
}

/** The bound group's ⋯ menu: what to copy, then the one that deletes, apart and in red. Unbind, which is safe, stays a button. */
export function worktreeMenu(groupId: string, worktree: { branch: string; path: string }): MenuEntry[] {
  return [
    { id: 'wt-copy-path', label: 'Copy worktree folder path', icon: 'copy', run: () => void import('./clipboard').then((m) => m.copyText(worktree.path)) },
    'separator',
    { id: 'remove-worktree', label: 'Remove worktree…', icon: 'trash', danger: true, run: () => void askRemoveWorktree(groupId, worktree.branch) }
  ]
}
