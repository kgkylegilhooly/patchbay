import type { AwayChanges } from './filesTouched'

/** What changed in each resumed agent's checkout while it was away, by node id. See src/main/files/away.ts. */
export type AwayByNode = Record<string, AwayChanges>

export interface AwayBridge {
  get(): Promise<AwayByNode>
  /** Sends the agent a short list of what changed, and clears its strip. */
  tell(nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }>
  dismiss(nodeId: string): Promise<void>
  onChange(cb: (away: AwayByNode) => void): () => void
}

/** The strip's one line: "While it was away: 5 files changed, 2 commits." */
export function awaySummary(a: AwayChanges): string {
  const files = a.files.length + a.moreFiles
  const commits = a.commits.length + a.moreCommits
  const parts = [files ? `${files} file${files === 1 ? '' : 's'} changed` : '', commits ? `${commits} commit${commits === 1 ? '' : 's'}` : ''].filter(Boolean)
  return `While it was away: ${parts.join(', ')}.`
}
