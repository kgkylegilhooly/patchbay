/** Types shared by the git panel, the board's GitHub cards, and main. */

export interface ChangeEntry {
  path: string
  /** Where a rename or copy came from. */
  origPath?: string
  /** git's status letter for this side: M, A, D, R, C, T, U for a conflict, or ? for untracked. */
  letter: string
  area: 'staged' | 'unstaged' | 'untracked' | 'conflict'
}

export interface RepoStatus {
  /** Null when HEAD is detached. */
  branch: string | null
  /** Null before the first commit. */
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: ChangeEntry[]
  /** Changed tracked files, then untracked ones. */
  unstaged: ChangeEntry[]
  conflicts: ChangeEntry[]
}

export interface BranchInfo {
  /** Short name, such as `main` or `origin/main`. */
  name: string
  remote: boolean
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** Its upstream was deleted. */
  gone: boolean
  oid: string
}

export interface GraphSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Which lane's color it takes. */
  lane: number
}

export interface CommitRow {
  hash: string
  short: string
  parents: string[]
  refs: string[]
  author: string
  time: number
  subject: string
  /** The commit's lane. */
  col: number
  /** How many lanes this row needs room for. */
  width: number
  merge: boolean
  segments: GraphSegment[]
}

export interface RepoChoice {
  /** The repository's top folder. */
  root: string
  /** Where it was found, in words, such as "Project folder" or "Worktree: feature-x". */
  label: string
}

/** What an action did, as git said it. */
export type GitOutcome = { ok: true; output: string } | { ok: false; error: string }

export interface DiffResult {
  text: string
  truncated: boolean
  binary: boolean
}

export interface GithubIssue {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  url: string
  author: string
  labels: string[]
  updatedAt: string
}

export interface GithubPr {
  number: number
  title: string
  state: string
  url: string
  author: string
  branch: string
  draft: boolean
  updatedAt: string
}

export type IssuesResult = { ok: true; repo: string; issues: GithubIssue[] } | { ok: false; error: string }

/** The bridge for the git panel and the board. Exposed beside the main bridge, as `window.patchbayWork`. */
export interface WorkBridge {
  /** The repositories these folders are in, each once. Only these can be used with the calls below. */
  gitRepos(folders: { path: string; label: string }[]): Promise<RepoChoice[]>
  gitStatus(root: string): Promise<{ ok: true; status: RepoStatus } | { ok: false; error: string }>
  gitDiff(root: string, path: string, staged: boolean): Promise<{ ok: true; diff: DiffResult } | { ok: false; error: string }>
  gitStage(root: string, paths: string[] | 'all'): Promise<GitOutcome>
  gitUnstage(root: string, paths: string[] | 'all'): Promise<GitOutcome>
  /** Only paths shown as unstaged or untracked right now are touched. Untracked ones are deleted. */
  gitDiscard(root: string, paths: string[]): Promise<GitOutcome>
  gitCommit(root: string, message: string): Promise<GitOutcome>
  gitBranches(root: string): Promise<{ ok: true; branches: BranchInfo[] } | { ok: false; error: string }>
  gitSwitch(root: string, branch: string): Promise<GitOutcome>
  gitCreateBranch(root: string, branch: string): Promise<GitOutcome>
  gitPush(root: string): Promise<GitOutcome>
  gitPull(root: string, mode: 'ff-only' | 'merge'): Promise<GitOutcome>
  gitFetch(root: string): Promise<GitOutcome>
  gitLog(root: string): Promise<{ ok: true; rows: CommitRow[]; truncated: boolean } | { ok: false; error: string }>
  /** The project's GitHub repository: its override, or else what its folder's origin points at. */
  githubRepo(projectId: string): Promise<{ ok: true; repo: string } | { ok: false; error: string }>
  /** Reads only. */
  githubIssues(projectId: string): Promise<IssuesResult>
  /** Writes to GitHub. Only ever called from the owner's own click, after a confirm. */
  githubIssueAction(projectId: string, number: number, action: { kind: 'close' } | { kind: 'reopen' } | { kind: 'comment'; body: string }): Promise<GitOutcome>
  /** Opens a Claude node on an issue with the prompt the owner was shown, optionally in a new worktree group. */
  startIssueAgent(a: { projectId: string; number: number; prompt: string; title: string; worktreeBranch?: string }): Promise<{ ok: true; nodeId: string } | { ok: false; error: string }>
  /** Opens a github.com page in the owner's browser. */
  openGithubPage(url: string): Promise<boolean>
}
