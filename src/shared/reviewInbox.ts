/**
 * The review inbox: task submissions waiting for a person, the changes behind them, and durable review comments.
 * Built on P1 task records. See docs/plans/review-inbox.md. Pure, so main, the window and tests share it.
 */
import type { Task, TaskVerification, TaskView } from './task'

export type ReviewSide = 'new' | 'old'

/** Where a comment was written: enough to find the same code again after edits, not only a line number. */
export interface ReviewAnchor {
  /** Relative to the repository's top folder, with forward slashes. */
  path: string
  side: ReviewSide
  /** 1-based, in the file as it was at `revision`. */
  line: number
  /** The commit, or Patchbay's snapshot tree of the working tree, the line was read from. */
  revision: string
  revisionKind: 'commit' | 'snapshot'
  /** The line's text, and up to CONTEXT lines either side, as they were. */
  snippet: string
  before: string[]
  after: string[]
}

export interface ReviewComment {
  id: string
  projectId: string
  taskId: string
  anchor: ReviewAnchor
  text: string
  /** The person's decision. An agent's reply never resolves a comment. Outdated is worked out, never stored. */
  status: 'open' | 'resolved'
  createdAt: number
  resolvedAt?: number
  /** When it last went to an agent in a fix request. */
  sentAt?: number
}

/** A recorded point a person reviewed: what "changes since last review" compares against. */
export interface ReviewMark {
  id: string
  projectId: string
  taskId: string
  root: string
  /** HEAD then, or null before the first commit. */
  head: string | null
  /** Patchbay's snapshot tree of the whole working tree then, untracked files included. */
  tree: string
  /** The base and merge-base the branch was compared against then, when there was one. */
  base?: string
  mergeBase?: string | null
  at: number
  reason: 'marked' | 'fixes-requested'
}

export interface ReviewData {
  version: 1
  comments: ReviewComment[]
  marks: ReviewMark[]
  /** The base branch chosen per task ("<projectId>/<taskId>"), so what was reviewed against stays fixed. */
  bases: Record<string, string>
}

export const emptyReviewData = (): ReviewData => ({ version: 1, comments: [], marks: [], bases: {} })
export const taskKey = (projectId: string, taskId: string): string => `${projectId}/${taskId}`

/** How many lines either side of a comment's line are kept to find it again. */
export const CONTEXT = 2

/** The anchor for a line of a file, read from the file's lines (1-based `line`). Null when the line isn't there. */
export function anchorAt(lines: string[], line: number): Pick<ReviewAnchor, 'line' | 'snippet' | 'before' | 'after'> | null {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null
  const i = line - 1
  return { line, snippet: lines[i], before: lines.slice(Math.max(0, i - CONTEXT), i), after: lines.slice(i + 1, i + 1 + CONTEXT) }
}

/** A file's text as lines. A final newline doesn't make one more line; Windows line ends match Unix ones. */
export function fileLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export type Placement =
  | { kind: 'same'; line: number }
  /** Found again at another line. `contextChanged`: the line itself is the same but the lines around it aren't. */
  | { kind: 'moved'; line: number; from: number; contextChanged: boolean }
  | { kind: 'outdated'; reason: string }

const contextMatches = (lines: string[], i: number, before: string[], after: string[]): boolean =>
  before.every((l, k) => lines[i - before.length + k] === l) && after.every((l, k) => lines[i + 1 + k] === l)

/** A line too plain to recognise by itself, such as `}` or a blank line. */
const trivial = (s: string): boolean => s.trim().replace(/[\s{}()[\];,]/g, '').length < 3

/**
 * Where an anchored line is in the file now. Never guesses: a line found in more than one place, or only a
 * plain line found without its context, is outdated rather than pinned somewhere it might not belong.
 */
export function placeAnchor(anchor: Pick<ReviewAnchor, 'line' | 'snippet' | 'before' | 'after'>, now: string[] | null): Placement {
  if (!now) return { kind: 'outdated', reason: 'The file is no longer there.' }
  const at = anchor.line - 1
  if (now[at] === anchor.snippet && contextMatches(now, at, anchor.before, anchor.after)) return { kind: 'same', line: anchor.line }
  const hits: number[] = []
  now.forEach((l, i) => { if (l === anchor.snippet) hits.push(i) })
  const withContext = hits.filter((i) => contextMatches(now, i, anchor.before, anchor.after))
  if (withContext.length === 1) {
    const i = withContext[0]
    return i === at ? { kind: 'same', line: anchor.line } : { kind: 'moved', line: i + 1, from: anchor.line, contextChanged: false }
  }
  if (withContext.length > 1) return { kind: 'outdated', reason: 'The code it was on now appears in more than one place.' }
  if (hits.length === 1 && !trivial(anchor.snippet)) {
    const i = hits[0]
    return { kind: 'moved', line: i + 1, from: anchor.line, contextChanged: true }
  }
  if (hits.length > 1) return { kind: 'outdated', reason: 'The line it was on now appears in more than one place, and the lines around it changed.' }
  return { kind: 'outdated', reason: 'The line it was on was changed or removed.' }
}

export type CommentState = 'open' | 'resolved' | 'outdated'

/** What a comment shows as: the person's resolve wins, then outdated, then open. */
export function commentState(c: Pick<ReviewComment, 'status'>, placement: Placement): CommentState {
  if (c.status === 'resolved') return 'resolved'
  return placement.kind === 'outdated' ? 'outdated' : 'open'
}

export interface CommentView extends ReviewComment {
  placement: Placement
  state: CommentState
}

/** Where a placement is, in words. */
export function placementText(p: Placement, side: ReviewSide): string {
  const where = side === 'new' ? 'line' : 'removed line'
  if (p.kind === 'same') return `${where} ${p.line}`
  if (p.kind === 'moved') return `${where} ${p.line} (moved from ${p.from}${p.contextChanged ? '; nearby lines changed' : ''})`
  return `outdated: ${p.reason}`
}

/** The fix request an agent gets: every unresolved comment, grouped by file, outdated ones said to be so. */
export function formatFixRequest(task: Pick<Task, 'id' | 'brief'>, comments: CommentView[], reviewed: string): string {
  const open = comments.filter((c) => c.state !== 'resolved')
  const files = [...new Set(open.map((c) => c.anchor.path))]
  const parts = [
    `Review of task "${task.brief.trim().replace(/\s+/g, ' ')}" (task ${task.id}). Please fix each comment below, then submit again with: patchbay task submit --task ${task.id} --summary "what you changed".`,
    `Reviewed: ${reviewed}.`
  ]
  for (const path of files) {
    parts.push('', `${path}:`)
    for (const c of open.filter((x) => x.anchor.path === path)) {
      const where = c.placement.kind === 'outdated'
        ? `${c.anchor.side === 'new' ? 'was line' : 'was removed line'} ${c.anchor.line} (this code changed since the comment; check it still applies)`
        : placementText(c.placement, c.anchor.side)
      parts.push(`- ${where}: \`${c.anchor.snippet.slice(0, 200).trim()}\``, `  ${c.text.trim().replace(/\n+/g, ' ')}`)
    }
  }
  return parts.join('\n')
}

/** Tasks waiting for a person: a current agent submission, ready or blocked by stale or missing checks. */
export function reviewQueue(views: TaskView[]): TaskView[] {
  const waiting = views.filter((v) => !!v.task.submissionId && (v.task.state === 'ready-for-review' || v.task.state === 'blocked'))
  const submittedAt = (v: TaskView): number => v.attempts.find((a) => a.id === v.task.submissionId)?.startedAt ?? v.task.updatedAt
  return waiting.sort((a, b) => submittedAt(b) - submittedAt(a))
}

/** Each kind of evidence carries where it came from, so a report, a command run and CI are never confused. */
export type Evidence =
  | { source: 'agent-report'; label: string; summary: string; at: number }
  | { source: 'command'; label: string; checkId: string; command: string; state: 'passed' | 'failed' | 'running' | 'not run' | 'stale'; detail: string; outputRef?: string }
  | { source: 'ci'; label: string; state: 'unavailable'; detail: string }

/**
 * The evidence for a task, labelled. Command state comes from P1's own readiness: a passing run P1 calls stale or
 * otherwise unusable shows as stale, with P1's reason. CI isn't read in this version, so it is unavailable, never passing.
 */
export function reviewEvidence(view: TaskView): Evidence[] {
  const out: Evidence[] = []
  const submission = view.attempts.find((a) => a.id === view.task.submissionId && a.kind === 'agent-report')
  if (submission?.kind === 'agent-report') out.push({ source: 'agent-report', label: "Agent's report (written by the agent, not checked)", summary: submission.summary, at: submission.startedAt })
  for (const check of view.task.requiredChecks) {
    const run = view.attempts.filter((a): a is TaskVerification => a.kind === 'command' && a.checkId === check.id).at(-1)
    const said = view.readiness.reasons.filter((r) => r.startsWith(`${check.id}:`)).map((r) => r.slice(check.id.length + 1).trim())
    const base = { source: 'command' as const, label: 'Command run recorded by Patchbay', checkId: check.id, command: check.command }
    if (!run) out.push({ ...base, state: 'not run', detail: 'No run recorded.' })
    else if (run.status === 'running') out.push({ ...base, state: 'running', detail: `Started ${new Date(run.startedAt).toLocaleString()}.`, outputRef: run.outputRef })
    else if (run.status !== 'passed' || run.exitCode !== 0) out.push({ ...base, state: 'failed', detail: `${run.status}${run.exitCode !== null ? `, exit ${run.exitCode}` : ''}${run.error ? `: ${run.error}` : ''}`, outputRef: run.outputRef })
    else if (said.length) out.push({ ...base, state: 'stale', detail: said.join('; '), outputRef: run.outputRef })
    else out.push({ ...base, state: 'passed', detail: 'exit 0, on the files as they are now.', outputRef: run.outputRef })
  }
  // This version reads no CI. Missing CI is never a pass.
  out.push({ source: 'ci', label: 'CI', state: 'unavailable', detail: 'Unavailable: Patchbay does not read CI yet. This is not a pass.' })
  return out
}

/** Who a checkout's changes can be put down to. A diff is the checkout's; it's one agent's only if one agent works there. */
export interface Attribution {
  /** Titles of the agents assigned to the task. */
  assigned: string[]
  /** Titles of other agents working in the same checkout. */
  others: string[]
  /** Exactly one agent works in this checkout and it's the task's. */
  sole: boolean
  note: string
}

export function attribution(assigned: string[], others: string[]): Attribution {
  const sole = assigned.length === 1 && others.length === 0
  let note: string
  if (assigned.length === 0) note = 'No agent is assigned to this task. These are the checkout\'s changes.'
  else if (sole) note = `Only ${assigned[0]} works in this checkout.`
  else {
    const all = [...assigned, ...others]
    note = `${all.length} agents work in this checkout (${all.join(', ')}). These are the checkout's changes, not any one agent's.`
  }
  return { assigned, others, sole, note }
}

export type CompareMode = { kind: 'branch'; base: string } | { kind: 'since-review' }
export type ChangeSection = 'committed' | 'local' | 'since-review'

export interface ChangedFile {
  path: string
  /** git's letter: A, M, D or T. */
  status: string
  section: ChangeSection
}

/** One side-by-side range: `from` and `to` are commits or snapshot trees. */
export interface ChangeRange { from: string; to: string }

export interface ChangeSet {
  root: string
  branch: string | null
  head: string | null
  /** Snapshot tree of the working tree now. */
  tree: string
  mode: CompareMode
  base?: { name: string; oid: string; mergeBase: string }
  /** The review this compares against, in since-review mode. */
  review?: ReviewMark
  ranges: Partial<Record<ChangeSection, ChangeRange>>
  files: ChangedFile[]
  /** Things the person should know about what's compared: base moved, history rewritten, snapshot gone. */
  notes: string[]
}

export interface InboxItem {
  view: TaskView
  root: string | null
  branch: string | null
  head: string | null
  /** Why the checkout couldn't be read, when it couldn't. */
  error?: string
  attribution: Attribution
  /** Assigned agents that can be sent fixes: on the canvas, agent windows. */
  agents: { id: string; title: string }[]
  openComments: number
  lastReview?: ReviewMark
  base: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** The inbox's calls to main, exposed as `window.patchbayReview`. Only the app's own window can call them. */
export interface ReviewBridge {
  inbox(projectId: string): Promise<Result<InboxItem[]>>
  branches(projectId: string, taskId: string): Promise<Result<string[]>>
  changes(projectId: string, taskId: string, mode: CompareMode): Promise<Result<ChangeSet>>
  fileDiff(projectId: string, taskId: string, range: ChangeRange, path: string): Promise<Result<{ text: string; truncated: boolean }>>
  comments(projectId: string, taskId: string): Promise<Result<CommentView[]>>
  addComment(projectId: string, taskId: string, c: { path: string; side: ReviewSide; line: number; revision: string; text: string }): Promise<Result<CommentView>>
  setCommentStatus(projectId: string, commentId: string, status: 'open' | 'resolved'): Promise<Result<true>>
  deleteComment(projectId: string, commentId: string): Promise<Result<true>>
  markReviewed(projectId: string, taskId: string): Promise<Result<ReviewMark>>
  requestFixes(projectId: string, taskId: string, sessionId: string): Promise<Result<{ queued: boolean; sent: number; to: string; recorded: boolean }>>
}

export const REVIEW_METHODS: (keyof ReviewBridge)[] = ['inbox', 'branches', 'changes', 'fileDiff', 'comments', 'addComment', 'setCommentStatus', 'deleteComment', 'markReviewed', 'requestFixes']

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str)

function isAnchor(a: unknown): a is ReviewAnchor {
  return object(a) && str(a.path) && (a.side === 'new' || a.side === 'old') && Number.isInteger(a.line) && (a.line as number) >= 1 &&
    str(a.revision) && (a.revisionKind === 'commit' || a.revisionKind === 'snapshot') && str(a.snippet) && strs(a.before) && strs(a.after)
}

export function isComment(c: unknown): c is ReviewComment {
  return object(c) && str(c.id) && str(c.projectId) && str(c.taskId) && isAnchor(c.anchor) && str(c.text) &&
    (c.status === 'open' || c.status === 'resolved') && num(c.createdAt) && (c.resolvedAt === undefined || num(c.resolvedAt)) && (c.sentAt === undefined || num(c.sentAt))
}

export function isMark(m: unknown): m is ReviewMark {
  return object(m) && str(m.id) && str(m.projectId) && str(m.taskId) && str(m.root) && (m.head === null || str(m.head)) && str(m.tree) &&
    (m.base === undefined || str(m.base)) && (m.mergeBase === undefined || m.mergeBase === null || str(m.mergeBase)) && num(m.at) &&
    (m.reason === 'marked' || m.reason === 'fixes-requested')
}

/** Review data as loaded: damaged records dropped one at a time, the rest kept. Says how many went. */
export function sanitizeReviewData(v: unknown): { data: ReviewData; dropped: number } {
  if (!object(v)) return { data: emptyReviewData(), dropped: v === undefined ? 0 : 1 }
  const rawComments = Array.isArray(v.comments) ? v.comments : []
  const rawMarks = Array.isArray(v.marks) ? v.marks : []
  const comments = rawComments.filter(isComment)
  const marks = rawMarks.filter(isMark)
  const bases: Record<string, string> = {}
  let dropped = rawComments.length - comments.length + rawMarks.length - marks.length
  if (object(v.bases)) for (const [k, b] of Object.entries(v.bases)) { if (str(b)) bases[k] = b; else dropped++ }
  return { data: { version: 1, comments, marks, bases }, dropped }
}
