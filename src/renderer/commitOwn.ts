import { create } from 'zustand'
import type {} from './lastReplyUi'

/**
 * F56: commit what an idle agent left uncommitted (F52's chip) without picking its files out by hand. The chip hands
 * the Git panel its files and its last reply's first line; the panel stages them and fills in the message. Nothing is
 * committed until the person presses Commit, and Unstage all takes it back.
 */

export interface CommitPrep {
  /** The agent's folder, for the panel to find the repository by. */
  folder: string
  /** From the repository's root, as the files service gives them. */
  paths: string[]
  message: string
  /** The agent's title, for what the panel says. */
  by: string
}

export const useCommitPrep = create<{ prep: CommitPrep | null }>(() => ({ prep: null }))

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The last reply's first line as a commit message: without the mark of a cut line, and nothing when there's none. */
export const commitMessageFrom = (headline: string | null | undefined): string => (headline ?? '').replace(/…$/, '').trim()

/** What the panel says once they're staged: how many, whether the message is the reply's, and what else would go in. */
export function stagedNotice(prep: Pick<CommitPrep, 'paths' | 'message' | 'by'>, stagedBefore: string[], messageUsed: boolean): string {
  const theirs = new Set(prep.paths)
  const others = stagedBefore.filter((p) => !theirs.has(p)).length
  return [
    `${prep.by}: ${plural(prep.paths.length, 'file')} staged${messageUsed ? ', with its last reply as the message' : ''}.`,
    others ? `${plural(others, 'other staged file')} would go in this commit too.` : '',
    'Nothing is committed until you press Commit.'
  ]
    .filter(Boolean)
    .join(' ')
}

/** The chip's click: reads the agent's last reply, then opens the Git panel on its folder to stage its files. */
export async function openCommitOwn(
  agent: { id: string; title: string; cwd: string },
  paths: string[],
  open: (folder: string) => void,
  read = (id: string) => window.patchbayReply?.headline(id)
): Promise<void> {
  const message = commitMessageFrom(await Promise.resolve(read(agent.id)).catch(() => null))
  useCommitPrep.setState({ prep: { folder: agent.cwd, paths, message, by: agent.title } })
  open(agent.cwd)
}
