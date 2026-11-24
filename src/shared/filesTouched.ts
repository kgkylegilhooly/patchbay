/** The files an agent session edited, and the snapshots taken as its turns started. See docs/plans/files-touched.md. */

export interface TouchedFile {
  /** Absolute, as the agent named it, resolved against the session's folder. */
  path: string
  firstAt: number
  lastAt: number
  /** The turn it was first and last edited in, or null for edits from before Patchbay recorded turns. */
  firstTurn: number | null
  lastTurn: number | null
  /** How many edits succeeded, or weren't seen to fail. */
  edits: number
  /** False when no edit of it was seen to succeed: the transcript never said how it went. */
  confirmed: boolean
  /** How many of `edits` this session's subagents made (Claude's Task tool), read from their own transcripts. */
  bySubagent?: number
  /**
   * Turns in which the file changed with no edit of it in the transcripts: the turn's snapshot and the checkout at the
   * end of the turn differ there. A shell command the agent ran, or another process, changed it. Never counted as
   * the agent's own edits; `edits` stays 0 for a file known only this way.
   */
  changedInTurns?: number[]
}

export interface TurnMark {
  turn: number
  at: number
  /** The checkout's root, when the session's folder is in a git repository. */
  root: string | null
  /** A git tree of the whole working copy as the turn started, untracked files included. */
  tree: string | null
  head: string | null
  /** Why there's no snapshot, in words. */
  problem?: string
  /** When the snapshot finished, or failed. */
  doneAt?: number
  /** The first edit seen in this turn. Before doneAt means the snapshot may already hold it. */
  firstEditAt?: number
  /** Untracked files too big or too many to go in the snapshot. */
  skipped?: number
  /** Other windows working in the same checkout when the turn started, by title. */
  shared?: string[]
  /**
   * The look at the checkout as the turn ended, for changes the transcripts don't explain. `changed` counts files
   * found that way; `problem` says why it wasn't done, or what it left out.
   */
  endCheck?: { at: number; changed: number; problem?: string }
  /**
   * The whole working copy as the turn ended, and HEAD then: what a resumed session is compared with, to say what
   * changed while it was away. Taken even when another window shares the checkout.
   */
  endTree?: string
  endHead?: string | null
  /** The checkout's root as the turn ended, which endTree belongs to. */
  endRoot?: string
}

/** What changed in a session's checkout since its last turn ended, as when it resumes after a restart. */
export interface AwayChanges {
  /** Paths from the repository's root, at most AWAY_MAX_FILES. */
  files: string[]
  moreFiles: number
  /** "abc1234 subject", newest first, at most AWAY_MAX_COMMITS. */
  commits: string[]
  moreCommits: number
  /** When the last turn ended. */
  since: number
  /** Other windows that worked in the same checkout as that turn ended, whose changes may be among these. */
  shared: string[]
}

export const AWAY_MAX_FILES = 30
export const AWAY_MAX_COMMITS = 10

/** The message "Tell it" sends: short, capped, and plain about what it can't tell apart. */
export function awayMessage(a: AwayChanges, when: (at: number) => string = (at) => new Date(at).toLocaleString()): string {
  const lines = [`While you were away (since your last turn ended, ${when(a.since)}), your checkout changed:`]
  if (a.commits.length) {
    lines.push(`New commits (${a.commits.length + a.moreCommits}):`, ...a.commits.map((c) => `- ${c}`))
    if (a.moreCommits) lines.push(`- and ${a.moreCommits} more`)
  }
  if (a.files.length) {
    lines.push(`Files that differ (${a.files.length + a.moreFiles}):`, ...a.files.map((f) => `- ${f}`))
    if (a.moreFiles) lines.push(`- and ${a.moreFiles} more`)
  }
  if (a.shared.length) lines.push(`${a.shared.join(', ')} also worked in this checkout, so some of these may be theirs.`)
  lines.push('Check these before you rely on what you knew of these files.')
  return lines.join('\n')
}

export interface OverlapNote {
  nodeId: string
  title: string
}

export interface SessionFiles {
  nodeId: string
  cwd: string
  files: TouchedFile[]
  turns: TurnMark[]
  /** Older files were dropped to keep the list bounded. */
  truncated: boolean
  /** By path: the other live agents that edited the same file. */
  overlaps: Record<string, OverlapNote[]>
}

export type DiffScope = 'turn' | 'session'

export type FileDiff =
  | { ok: true; text: string; truncated: boolean; base: string }
  | { ok: false; reason: string }

/** What a chip shows without asking for the list. */
export interface FilesBadge {
  /** Files the session edited: its own edit calls or its subagents'. */
  count: number
  overlap: number
  /** Files only changed during its turns by a command or another process. Never counted as edited. */
  changed?: number
}

export type FilesSummary = Record<string, FilesBadge>

/** `window.patchbayFiles`, served on `pb:files:*` by src/main/files/ipc.ts. */
export interface FilesBridge {
  get(nodeId: string): Promise<SessionFiles | null>
  diff(nodeId: string, path: string, scope: DiffScope): Promise<FileDiff>
  summary(): Promise<FilesSummary>
  /** Called with the whole summary each time it changes. Returns a function that stops it. */
  onSummary(cb: (summary: FilesSummary) => void): () => void
}
