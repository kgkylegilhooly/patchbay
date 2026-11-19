/**
 * Comparing two attempts at one brief, each in its own worktree from one recorded commit. Types, the checks on a start
 * request, and the rules for what removal must ask about. Pure, so they can be tested without git or a window.
 * See docs/plans/compare.md.
 */
import type { AgentKind } from './model'

export type AttemptKey = 'a' | 'b'
export const ATTEMPT_KEYS: AttemptKey[] = ['a', 'b']
export const attemptLabel = (key: AttemptKey): string => key.toUpperCase()

/** The commit both attempts start from, and what was true of the checkout it came from. */
export interface Baseline {
  /** Full commit id. */
  commit: string
  /** The branch the source checkout was on, or null when HEAD was detached. */
  branch: string | null
  /** The checkout HEAD was read from. */
  source: string
  /** The repository root the worktrees were made from. */
  repo: string
  /** Whether that checkout had uncommitted changes, which the person chose to leave out. Never copied. */
  uncommitted: 'none' | 'left-out'
}

/** One run of the verification command in one attempt's worktree. */
export interface VerifyResult {
  argv: string[]
  cwd: string
  /** Null when it didn't end by itself: it timed out, or never started. */
  exitCode: number | null
  startedAt: number
  durationMs: number
  /** The end of the output, stdout and stderr together as the launcher wrote them. */
  output: string
  truncated: boolean
  timedOut: boolean
  /** The program couldn't be started at all. */
  missing: boolean
  /** The attempt's commit when it ran, and whether it had uncommitted changes. */
  head: string | null
  /** A fingerprint of the uncommitted changes when it ran, so a later change marks the result as older. */
  changes: string
}

export interface Attempt {
  key: AttemptKey
  agent: AgentKind
  /** What this attempt was asked to do differently, added to the brief. May be empty. */
  approach: string
  /** The prompt the agent was started with. */
  prompt: string
  branch: string
  path: string
  nodeId: string
  groupId: string
  verify?: VerifyResult
  /** The worktree was removed through the comparison. */
  removed?: { at: number; branchDeleted: boolean }
}

export interface Comparison {
  id: string
  projectId: string
  title: string
  brief: string
  base: Baseline
  /** Run in each worktree, one after the other. An argument list: no shell reads it. Null when none was given. */
  verify: string[] | null
  createdAt: number
  attempts: Attempt[]
  /** The person's choice. A record only: nothing is merged, committed or switched. */
  chosen?: { key: AttemptKey; at: number; head: string | null }
  /** P1 hook: the task this comparison belongs to, once tasks exist. Unused in this slice. */
  taskId?: string
}

/** What the start dialog shows about the source checkout before anything is made. */
export type SourceInfo =
  | { ok: true; repo: string; source: string; commit: string; branch: string | null; subject: string; uncommitted: string[]; uncommittedMore: number }
  | { ok: false; reason: string }

export interface AttemptRequest {
  agent: AgentKind
  approach: string
  branch: string
}

export interface StartComparison {
  projectId: string
  /** A folder in the source checkout. Its repository is where the worktrees are made from. */
  source: string
  brief: string
  /** The commit the dialog showed. Both attempts start here, even if HEAD has moved since. */
  base: string
  /** Required when the checkout has uncommitted changes: they are left out of both attempts, never copied. */
  leaveOutUncommitted: boolean
  attempts: AttemptRequest[]
  /** An argument list as typed, or empty for none. */
  verify: string
  taskId?: string
}

export type StartResult = { ok: true; comparison: Comparison } | { ok: false; reason: string; comparison?: Comparison }

export interface FileChange {
  path: string
  /** Null for a binary file. */
  added: number | null
  removed: number | null
  untracked?: boolean
}

/** What an attempt holds now, read from git. Reading changes nothing. */
export type AttemptState =
  | {
      ok: true
      head: string | null
      /** The worktree's checked-out branch now, which the agent may have changed. */
      branch: string | null
      /** Commits since the base, newest first. */
      commits: { hash: string; subject: string }[]
      /** base..HEAD */
      committed: FileChange[]
      /** HEAD to the working tree, staged and unstaged together, then untracked files. */
      uncommitted: FileChange[]
      /** Whether HEAD still has the base in its history. */
      fromBase: boolean
      /** Commits on the branch that no other local branch has. */
      unmerged: number
      changes: string
    }
  | { ok: false; reason: string; gone: boolean }

/** What removing an attempt's worktree (and maybe branch) would lose. Shown, and sent back to confirm. */
export interface RemovalCheck {
  head: string | null
  uncommitted: number
  unmerged: number
}

export type RemoveResult = { ok: true; comparison: Comparison } | { ok: false; reason: string; needs?: RemovalCheck }

/** The renderer's calls, as `window.patchbayCompare`. Served in src/main/compare/ipc.ts. */
export interface CompareBridge {
  inspect(folder: string): Promise<SourceInfo>
  start(req: StartComparison): Promise<StartResult>
  list(projectId: string): Promise<Comparison[]>
  get(id: string): Promise<Comparison | null>
  state(id: string, key: AttemptKey): Promise<AttemptState>
  diff(id: string, key: AttemptKey, path: string, side: 'committed' | 'uncommitted'): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; reason: string }>
  verify(id: string, key: AttemptKey): Promise<{ ok: true; comparison: Comparison } | { ok: false; reason: string }>
  choose(id: string, key: AttemptKey | null): Promise<{ ok: true; comparison: Comparison } | { ok: false; reason: string }>
  remove(id: string, key: AttemptKey, opts: { deleteBranch: boolean; confirm?: RemovalCheck }): Promise<RemoveResult>
  forget(id: string): Promise<{ ok: true } | { ok: false; reason: string }>
}

// Start requests

export const MAX_BRIEF_CHARS = 20000
const MAX_APPROACH_CHARS = 4000

/** A branch name from the brief's first words: `try/fix-login-a`. */
export function suggestBranches(brief: string): Record<AttemptKey, string> {
  const slug =
    brief
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-')
      .slice(0, 40)
      .replace(/-+$/, '') || 'attempt'
  return { a: `try/${slug}-a`, b: `try/${slug}-b` }
}

/** A short title from the brief's first line. */
export function titleFor(brief: string): string {
  const line = brief.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Comparison'
}

/** The brief, with the attempt's approach after it when there is one. Both attempts get the same brief, word for word. */
export function attemptPrompt(brief: string, approach: string): string {
  const a = approach.trim()
  return a ? `${brief.trim()}\n\nApproach for this attempt: ${a}` : brief.trim()
}

/** Plain branch names only: no spaces, no `..`, no leading `-`. git checks again before it makes one. */
export function plainBranch(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.') && !name.includes('..') && !name.includes('//') && !name.endsWith('.lock')
}

export const FULL_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** Splits a verification command into arguments. Shell syntax is refused: the command never goes through a shell. */
export function verifyArgv(text: string): { ok: true; argv: string[] | null } | { ok: false; reason: string } {
  const t = text.trim()
  if (!t) return { ok: true, argv: null }
  if (/["'`$&|<>;()%^!\r\n]/.test(t)) return { ok: false, reason: 'The verification command runs without a shell, so it can\'t use quotes, pipes, && or variables. Name a script instead, such as "npm test".' }
  return { ok: true, argv: t.split(/\s+/) }
}

/**
 * Why a start request can't be used as it is, or null. Checked before anything is made. `source` is what the
 * checkout holds now: uncommitted changes there need the explicit choice to leave them out.
 */
export function startProblem(req: StartComparison, source: SourceInfo): string | null {
  if (!source.ok) return source.reason
  if (typeof req.brief !== 'string' || !req.brief.trim()) return 'Write the brief both attempts start from.'
  if (req.brief.length > MAX_BRIEF_CHARS) return `The brief must be at most ${MAX_BRIEF_CHARS} characters.`
  if (typeof req.base !== 'string' || !FULL_COMMIT.test(req.base)) return 'There is no base commit to start from.'
  if (!Array.isArray(req.attempts) || req.attempts.length !== 2) return 'Choose two attempts.'
  for (const a of req.attempts) {
    if (a.agent !== 'claude' && a.agent !== 'codex') return 'Each attempt needs Claude Code or Codex.'
    if (typeof a.approach !== 'string' || a.approach.length > MAX_APPROACH_CHARS) return `An approach must be at most ${MAX_APPROACH_CHARS} characters.`
    if (typeof a.branch !== 'string' || !plainBranch(a.branch.trim())) return `"${a.branch}" can't be a branch name. Use letters, numbers, - _ . and /.`
  }
  if (req.attempts[0].branch.trim() === req.attempts[1].branch.trim()) return 'The two attempts need different branches.'
  if (source.uncommitted.length > 0 && req.leaveOutUncommitted !== true) {
    const n = source.uncommitted.length + source.uncommittedMore
    return `${source.source} has ${n} uncommitted change${n === 1 ? '' : 's'}. Choose to leave ${n === 1 ? 'it' : 'them'} out of both attempts, or commit first.`
  }
  const verify = verifyArgv(req.verify ?? '')
  if (!verify.ok) return verify.reason
  return null
}

// Removal

/** What removal would lose, and so must be confirmed, or null when nothing would be. */
export function removalNeeds(state: Pick<RemovalCheck, 'head' | 'uncommitted' | 'unmerged'>, deleteBranch: boolean): RemovalCheck | null {
  const unmerged = deleteBranch ? state.unmerged : 0
  return state.uncommitted > 0 || unmerged > 0 ? { head: state.head, uncommitted: state.uncommitted, unmerged } : null
}

/** A confirmation counts only for exactly what was shown: the same commit, and the same changes to lose. */
export function confirmCovers(needs: RemovalCheck, confirm: RemovalCheck | undefined): boolean {
  return !!confirm && confirm.head === needs.head && confirm.uncommitted === needs.uncommitted && confirm.unmerged === needs.unmerged
}

/** What a removal needing confirmation would lose, in words. */
export function describeLoss(needs: RemovalCheck, branch: string): string {
  const parts: string[] = []
  if (needs.uncommitted) parts.push(`${needs.uncommitted} file${needs.uncommitted === 1 ? '' : 's'} with uncommitted changes`)
  if (needs.unmerged) parts.push(`${needs.unmerged} commit${needs.unmerged === 1 ? '' : 's'} on ${branch} that no other branch has`)
  return parts.join(' and ')
}

// Verification

export type VerifyStanding = { kind: 'not-run' } | { kind: 'unavailable'; why: string } | { kind: 'current'; result: VerifyResult } | { kind: 'older'; result: VerifyResult }

/** How a stored result stands against the attempt now. A result from another commit or other changes is older. */
export function verifyStanding(attempt: Pick<Attempt, 'verify' | 'removed'>, state: AttemptState | null): VerifyStanding {
  const result = attempt.verify
  if (attempt.removed) return result ? { kind: 'older', result } : { kind: 'unavailable', why: 'The worktree was removed.' }
  if (state && !state.ok && state.gone && !result) return { kind: 'unavailable', why: state.reason }
  if (!result) return { kind: 'not-run' }
  if (!state || !state.ok) return { kind: 'older', result }
  return state.head === result.head && state.changes === result.changes ? { kind: 'current', result } : { kind: 'older', result }
}

export const VERIFY_OUTPUT_LIMIT = 64 * 1024

/** The end of the output, since that's where test runners say what happened. */
export function tailOutput(text: string, limit = VERIFY_OUTPUT_LIMIT): { output: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n')
  return plain.length > limit ? { output: plain.slice(plain.length - limit), truncated: true } : { output: plain, truncated: false }
}

// Reading the stored file

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function readVerify(v: unknown): VerifyResult | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (!Array.isArray(r.argv) || !r.argv.every((a) => typeof a === 'string') || str(r.cwd) === null || num(r.startedAt) === null) return undefined
  return {
    argv: r.argv as string[],
    cwd: r.cwd as string,
    exitCode: num(r.exitCode),
    startedAt: r.startedAt as number,
    durationMs: num(r.durationMs) ?? 0,
    output: str(r.output) ?? '',
    truncated: r.truncated === true,
    timedOut: r.timedOut === true,
    missing: r.missing === true,
    head: str(r.head),
    changes: str(r.changes) ?? ''
  }
}

function readAttempt(v: unknown): Attempt | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if ((r.key !== 'a' && r.key !== 'b') || (r.agent !== 'claude' && r.agent !== 'codex')) return null
  const fields = ['prompt', 'branch', 'path', 'nodeId', 'groupId'] as const
  if (fields.some((f) => str(r[f]) === null)) return null
  const removed = r.removed && typeof r.removed === 'object' ? (r.removed as Record<string, unknown>) : null
  const verify = readVerify(r.verify)
  return {
    key: r.key,
    agent: r.agent,
    approach: str(r.approach) ?? '',
    prompt: r.prompt as string,
    branch: r.branch as string,
    path: r.path as string,
    nodeId: r.nodeId as string,
    groupId: r.groupId as string,
    ...(verify ? { verify } : {}),
    ...(removed && num(removed.at) !== null ? { removed: { at: removed.at as number, branchDeleted: removed.branchDeleted === true } } : {})
  }
}

/** One stored comparison, field by field: anything unknown is dropped, and a record missing what it needs is null. */
export function readComparison(v: unknown): Comparison | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const b = r.base && typeof r.base === 'object' ? (r.base as Record<string, unknown>) : null
  if (!b || str(b.commit) === null || str(b.source) === null || str(b.repo) === null) return null
  if (str(r.id) === null || str(r.projectId) === null || str(r.brief) === null || num(r.createdAt) === null || !Array.isArray(r.attempts)) return null
  const attempts = r.attempts.map(readAttempt).filter((a): a is Attempt => a !== null)
  const c = r.chosen && typeof r.chosen === 'object' ? (r.chosen as Record<string, unknown>) : null
  const verify = Array.isArray(r.verify) && r.verify.length && r.verify.every((a) => typeof a === 'string') ? (r.verify as string[]) : null
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    title: str(r.title) ?? titleFor(r.brief as string),
    brief: r.brief as string,
    base: { commit: b.commit as string, branch: str(b.branch), source: b.source as string, repo: b.repo as string, uncommitted: b.uncommitted === 'left-out' ? 'left-out' : 'none' },
    verify,
    createdAt: r.createdAt as number,
    attempts,
    ...(c && (c.key === 'a' || c.key === 'b') && num(c.at) !== null && attempts.some((a) => a.key === c.key) ? { chosen: { key: c.key, at: c.at as number, head: str(c.head) } } : {}),
    ...(str(r.taskId) ? { taskId: r.taskId as string } : {})
  }
}

export const COMPARE_SCHEMA = 1

/** The stored file. Throws when it isn't one this build can read, so the caller can keep it aside rather than lose it. */
export function readComparisonFile(json: unknown): Comparison[] {
  if (!json || typeof json !== 'object' || (json as { schema?: unknown }).schema !== COMPARE_SCHEMA) throw new Error('Not a comparisons file this version can read.')
  const list = (json as { comparisons?: unknown }).comparisons
  if (!Array.isArray(list)) throw new Error('The comparisons file has no list.')
  return list.map(readComparison).filter((c): c is Comparison => c !== null)
}
