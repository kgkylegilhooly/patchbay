/** Public task/evidence contract. Canvas session IDs are stable across process restarts. */
export type TaskState = 'planned' | 'running' | 'blocked' | 'ready-for-review' | 'accepted' | 'cancelled'
export interface TaskRevision {
  revision: string | null
  uncommitted: boolean | null
  /** Git-visible content, including untracked files. Null means identity was unavailable. */
  fingerprint: string | null
  /** The folder isn't in a git repository, so there is no identity to compare: freshness can't be checked. */
  noRepo?: boolean
  /** Why identity is unavailable, when it is. */
  reason?: string
}
export interface TaskCheck { id: string; command: string; cwd: string }
/** Who declared a task, and so its required checks. */
export type TaskAuthor = { kind: 'agent'; sessionId: string } | { kind: 'person' }
export interface Task {
  id: string
  projectId: string
  brief: string
  acceptanceCriteria: string[]
  assignedSessionIds: string[]
  cwd: string
  state: TaskState
  requiredChecks: TaskCheck[]
  dependsOn: string[]
  createdAt: number
  updatedAt: number
  /** Absent in tasks made before this was recorded. */
  createdBy?: TaskAuthor
  submissionId?: string
  /** Human decisions are separate from agent submissions and survive retries. */
  acceptances: { submissionId: string; at: number; by: 'human'; revision: TaskRevision }[]
}
interface AttemptBase { id: string; taskId: string; sessionId: string; startedAt: number }
export interface TaskSubmission extends AttemptBase {
  kind: 'agent-report'
  summary: string
  endedAt: number
  revision: TaskRevision
}
export interface TaskVerification extends AttemptBase {
  kind: 'command'
  checkId: string
  command: string
  cwd: string
  endedAt: number | null
  exitCode: number | null
  status: 'running' | 'passed' | 'failed' | 'interrupted'
  outputRef: string
  revision: TaskRevision
  endRevision?: TaskRevision
  error?: string
  /**
   * Set when this run was a comparison's verification in one attempt's worktree (src/shared/taskCompare.ts), started
   * by the person from the comparison view. It ran in that worktree, not in the task's folder, so it never stands in
   * for a required check. `sessionId` is then the attempt's agent, whose work it checked.
   */
  comparison?: { id: string; key: 'a' | 'b' }
}
/**
 * A recorded browser check an agent made for this task (see shared/browserEvidence.ts). Its outcome is the agent's
 * claim, so it never counts towards readiness. The pictures and diagnostics stay with the browser node.
 */
export interface TaskBrowserCheck extends AttemptBase {
  kind: 'browser'
  nodeId: string
  browserAttemptId: string
  url: string
  state: 'recording' | 'recorded' | 'incomplete'
  assertion: 'passed' | 'failed' | 'unknown'
  endedAt: number | null
  /** How many gaps the attempt reported, such as missing pictures or an interruption. */
  gaps: number
  revision: TaskRevision
}
/**
 * One attempt of a comparison started for this task: its own worktree, branch and agent, from the comparison's base
 * commit. Evidence only: it never counts towards readiness, and choosing it is a record, never a merge.
 */
export interface TaskComparisonAttempt extends AttemptBase {
  kind: 'comparison'
  comparisonId: string
  key: 'a' | 'b'
  /** The comparison's title, so it can be shown without the comparisons file. */
  title: string
  agent: string
  branch: string
  path: string
  /** The commit both attempts started from. */
  base: string
  /** The base commit as an identity. Its fingerprint is null: nothing is compared against it. */
  revision: TaskRevision
  /** The person chose this attempt in the comparison view: when, and the commit the attempt was at. */
  chosen?: { at: number; head: string | null }
}
export type TaskAttempt = TaskSubmission | TaskVerification | TaskBrowserCheck | TaskComparisonAttempt
export interface TaskRecords {
  tasks: Task[]
  attempts: TaskAttempt[]
  /**
   * Attempts of kinds this version doesn't know, such as browser evidence from a newer Patchbay, kept as they were so
   * nothing is lost by opening the canvas in this one. They never count towards readiness here.
   */
  other?: Record<string, unknown>[]
}
export const emptyTasks = (): TaskRecords => ({ tasks: [], attempts: [] })
export interface TaskReadiness {
  ready: boolean
  /** Why it isn't ready. */
  reasons: string[]
  /** What the person should know even when it is ready, such as freshness that can't be checked. */
  warnings: string[]
}
export interface TaskView { task: Task; attempts: TaskAttempt[]; readiness: TaskReadiness }

/** Whether two identities name the same content. Two "no repository" identities match: there is nothing to compare. */
export function sameRevision(a: TaskRevision, b: TaskRevision): boolean {
  if (a.noRepo && b.noRepo) return true
  return a.revision !== null && a.fingerprint !== null && a.uncommitted !== null &&
    a.revision === b.revision && a.fingerprint === b.fingerprint && a.uncommitted === b.uncommitted
}

const unknownWhy = (r: TaskRevision | undefined): string => (r?.reason ? ` (${r.reason})` : '')

/** No launching, status hooks or disappearing-node shortcuts. Missing evidence fails closed. */
export function taskReadiness(records: TaskRecords, task: Task, revisions: Record<string, TaskRevision>, path = new Set<string>()): TaskReadiness {
  const reasons: string[] = []
  const warnings: string[] = []
  if (path.has(task.id)) return { ready: false, reasons: ['Task dependency cycle'], warnings }
  const next = new Set(path).add(task.id)
  if (task.state === 'cancelled') reasons.push('Task is cancelled')
  for (const id of task.dependsOn) {
    const upstream = records.tasks.find((t) => t.id === id)
    if (!upstream || upstream.state !== 'accepted' || !taskReadiness(records, upstream, revisions, next).ready) {
      reasons.push(`Upstream task ${id} is missing, unaccepted or has stale checks`)
    }
  }
  const now = revisions[task.cwd]
  const submission = records.attempts.find((a) => a.id === task.submissionId && a.taskId === task.id && a.kind === 'agent-report')
  if (!submission) reasons.push('No agent submission')
  else if (!now || !sameRevision(submission.revision, now)) reasons.push(`Submission revision is stale or unknown${unknownWhy(now)}`)
  if (now?.noRepo) warnings.push(`${task.cwd} isn't in a git repository, so changes since the submission can't be detected`)
  for (const check of task.requiredChecks) {
    const attempt = records.attempts.filter((a): a is TaskVerification => a.taskId === task.id && a.kind === 'command' && !a.comparison && a.checkId === check.id).at(-1)
    const current = revisions[check.cwd]
    if (!attempt || attempt.status !== 'passed' || attempt.exitCode !== 0) reasons.push(`${check.id}: missing or not passing`)
    else if (attempt.command !== check.command || attempt.cwd !== check.cwd) reasons.push(`${check.id}: ran a different command or folder than declared`)
    else if (!attempt.endRevision || !sameRevision(attempt.revision, attempt.endRevision)) {
      reasons.push(`${check.id}: the check changed the files it checked while it ran, so its result isn't about one revision. Commit or ignore what it writes`)
    } else if (!current || !sameRevision(attempt.revision, current)) reasons.push(`${check.id}: stale or unknown revision${unknownWhy(current)}`)
    else if (current.noRepo) warnings.push(`${check.id}: ${check.cwd} isn't in a git repository, so later changes can't be detected`)
  }
  return { ready: reasons.length === 0, reasons, warnings }
}

export function workingState(task: Task, state: TaskState, now: number): Task {
  if (!['planned', 'running', 'blocked', 'cancelled'].includes(state)) throw new Error('Submit for review; only a person can accept in the UI')
  if (task.state === 'cancelled') throw new Error('Cancelled tasks are final; create a new task')
  return { ...task, state, submissionId: undefined, updatedAt: now }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const revision = (v: unknown): boolean => object(v) && (v.revision === null || typeof v.revision === 'string') &&
  (v.fingerprint === null || typeof v.fingerprint === 'string') && (v.uncommitted === null || typeof v.uncommitted === 'boolean') &&
  (v.noRepo === undefined || typeof v.noRepo === 'boolean') && (v.reason === undefined || typeof v.reason === 'string')
const author = (v: unknown): boolean => v === undefined || (object(v) && (v.kind === 'person' || (v.kind === 'agent' && typeof v.sessionId === 'string')))

export function isTask(t: unknown): t is Task {
  return object(t) && typeof t.id === 'string' && typeof t.projectId === 'string' && typeof t.brief === 'string' &&
    typeof t.cwd === 'string' && strings(t.acceptanceCriteria) && strings(t.assignedSessionIds) && strings(t.dependsOn) &&
    ['planned', 'running', 'blocked', 'ready-for-review', 'accepted', 'cancelled'].includes(String(t.state)) && time(t.createdAt) && time(t.updatedAt) &&
    (t.submissionId === undefined || typeof t.submissionId === 'string') && author(t.createdBy) &&
    Array.isArray(t.requiredChecks) && t.requiredChecks.every((c) => object(c) && typeof c.id === 'string' && typeof c.command === 'string' && typeof c.cwd === 'string') &&
    Array.isArray(t.acceptances) && t.acceptances.every((a) => object(a) && a.by === 'human' && typeof a.submissionId === 'string' && time(a.at) && revision(a.revision))
}

export function isAttempt(a: unknown): a is TaskAttempt {
  if (!object(a) || typeof a.id !== 'string' || typeof a.taskId !== 'string' || typeof a.sessionId !== 'string' || !time(a.startedAt) || !revision(a.revision)) return false
  if (a.kind === 'agent-report') return typeof a.summary === 'string' && time(a.endedAt)
  if (a.kind === 'comparison') {
    return typeof a.comparisonId === 'string' && (a.key === 'a' || a.key === 'b') && typeof a.title === 'string' && typeof a.agent === 'string' &&
      typeof a.branch === 'string' && typeof a.path === 'string' && typeof a.base === 'string' &&
      (a.chosen === undefined || (object(a.chosen) && time(a.chosen.at) && (a.chosen.head === null || typeof a.chosen.head === 'string')))
  }
  if (a.kind === 'browser') {
    return typeof a.nodeId === 'string' && typeof a.browserAttemptId === 'string' && typeof a.url === 'string' &&
      ['recording', 'recorded', 'incomplete'].includes(String(a.state)) && ['passed', 'failed', 'unknown'].includes(String(a.assertion)) &&
      (a.endedAt === null || time(a.endedAt)) && Number.isInteger(a.gaps)
  }
  return a.kind === 'command' && typeof a.checkId === 'string' && typeof a.command === 'string' && typeof a.cwd === 'string' && typeof a.outputRef === 'string' &&
    (a.endedAt === null || time(a.endedAt)) && (a.exitCode === null || Number.isInteger(a.exitCode)) && ['running', 'passed', 'failed', 'interrupted'].includes(String(a.status)) &&
    (a.endRevision === undefined || revision(a.endRevision)) && (a.error === undefined || typeof a.error === 'string') &&
    (a.comparison === undefined || (object(a.comparison) && typeof a.comparison.id === 'string' && (a.comparison.key === 'a' || a.comparison.key === 'b')))
}

const KNOWN_KINDS = new Set(['agent-report', 'command', 'browser', 'comparison'])

/**
 * Task data as loaded, with anything damaged dropped one record at a time, so a bad record never costs the canvas or
 * the other tasks. Attempts of kinds this version doesn't know are kept aside, unread. Says how many were dropped.
 * Null when there's nothing usable at all.
 */
export function sanitizeTasks(v: unknown): { records: TaskRecords; dropped: number } | null {
  if (!object(v)) return null
  const rawTasks = Array.isArray(v.tasks) ? v.tasks : []
  const rawAttempts = Array.isArray(v.attempts) ? v.attempts : []
  const rawOther = Array.isArray(v.other) ? v.other : []
  const tasks = rawTasks.filter(isTask)
  const attempts: TaskAttempt[] = []
  const other: Record<string, unknown>[] = rawOther.filter(object)
  let dropped = rawTasks.length - tasks.length + (rawOther.length - other.length)
  for (const a of rawAttempts) {
    if (isAttempt(a)) attempts.push(a)
    else if (object(a) && typeof a.kind === 'string' && !KNOWN_KINDS.has(a.kind) && typeof a.id === 'string' && typeof a.taskId === 'string') other.push(a)
    else dropped++
  }
  return { records: { tasks, attempts, ...(other.length ? { other } : {}) }, dropped }
}

/** Whether task data is whole, with nothing to drop. Loading uses sanitizeTasks, which keeps the good part of anything. */
export function isTaskRecords(v: unknown): v is TaskRecords {
  const clean = sanitizeTasks(v)
  return !!clean && clean.dropped === 0 && Array.isArray((v as TaskRecords).tasks) && Array.isArray((v as TaskRecords).attempts)
}

export function recoverTasks(records: TaskRecords, now = Date.now()): TaskRecords {
  // A browser check still recording when the app stopped ended there, as the browser's own record says.
  if (records.attempts.some((a) => a.kind === 'browser' && a.state === 'recording')) {
    records = {
      ...records,
      attempts: records.attempts.map((a) => (a.kind === 'browser' && a.state === 'recording' ? { ...a, state: 'incomplete', endedAt: now, gaps: a.gaps + 1 } : a))
    }
  }
  const interrupted = new Set(records.attempts.filter((a) => a.kind === 'command' && a.status === 'running').map((a) => a.taskId))
  if (!interrupted.size) return records
  return {
    ...records,
    tasks: records.tasks.map((t) => interrupted.has(t.id) && t.state !== 'cancelled' ? { ...t, state: 'blocked', updatedAt: now } : t),
    attempts: records.attempts.map((a) => a.kind === 'command' && a.status === 'running' ? { ...a, status: 'interrupted', endedAt: now, error: 'App stopped before completion was recorded; run a new attempt' } : a)
  }
}
