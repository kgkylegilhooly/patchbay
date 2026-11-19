/** Public task/evidence contract. Canvas session IDs are stable across process restarts. */
export type TaskState = 'planned' | 'running' | 'blocked' | 'ready-for-review' | 'accepted' | 'cancelled'
export interface TaskRevision {
  revision: string | null
  uncommitted: boolean | null
  /** Git-visible content, including untracked files. Null means identity was unavailable. */
  fingerprint: string | null
}
export interface TaskCheck { id: string; command: string; cwd: string }
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
}
export type TaskAttempt = TaskSubmission | TaskVerification
export interface TaskRecords { tasks: Task[]; attempts: TaskAttempt[] }
export const emptyTasks = (): TaskRecords => ({ tasks: [], attempts: [] })
export interface TaskReadiness { ready: boolean; reasons: string[] }
export interface TaskView { task: Task; attempts: TaskAttempt[]; readiness: TaskReadiness }

export function sameRevision(a: TaskRevision, b: TaskRevision): boolean {
  return a.revision !== null && a.fingerprint !== null && a.uncommitted !== null &&
    a.revision === b.revision && a.fingerprint === b.fingerprint && a.uncommitted === b.uncommitted
}

/** No launching, status hooks or disappearing-node shortcuts. Missing evidence fails closed. */
export function taskReadiness(records: TaskRecords, task: Task, revisions: Record<string, TaskRevision>, path = new Set<string>()): TaskReadiness {
  const reasons: string[] = []
  if (path.has(task.id)) return { ready: false, reasons: ['Task dependency cycle'] }
  const next = new Set(path).add(task.id)
  if (task.state === 'cancelled') reasons.push('Task is cancelled')
  for (const id of task.dependsOn) {
    const upstream = records.tasks.find((t) => t.id === id)
    if (!upstream || upstream.state !== 'accepted' || !taskReadiness(records, upstream, revisions, next).ready) {
      reasons.push(`Upstream task ${id} is missing, unaccepted or has stale checks`)
    }
  }
  const submission = records.attempts.find((a) => a.id === task.submissionId && a.taskId === task.id && a.kind === 'agent-report')
  if (!submission) reasons.push('No agent submission')
  else if (!revisions[task.cwd] || !sameRevision(submission.revision, revisions[task.cwd])) reasons.push('Submission revision is stale or unknown')
  for (const check of task.requiredChecks) {
    const attempt = records.attempts.filter((a): a is TaskVerification => a.taskId === task.id && a.kind === 'command' && a.checkId === check.id).at(-1)
    if (!attempt || attempt.status !== 'passed' || attempt.exitCode !== 0) reasons.push(`${check.id}: missing or not passing`)
    else if (attempt.command !== check.command || attempt.cwd !== check.cwd || !attempt.endRevision ||
      !sameRevision(attempt.revision, attempt.endRevision) || !revisions[check.cwd] || !sameRevision(attempt.revision, revisions[check.cwd])) {
      reasons.push(`${check.id}: stale or unknown revision`)
    }
  }
  return { ready: reasons.length === 0, reasons }
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
  (v.fingerprint === null || typeof v.fingerprint === 'string') && (v.uncommitted === null || typeof v.uncommitted === 'boolean')
/** Strict validation avoids replacing corrupted outcomes with an empty success history. */
export function isTaskRecords(v: unknown): v is TaskRecords {
  if (!object(v) || !Array.isArray(v.tasks) || !Array.isArray(v.attempts)) return false
  return v.tasks.every((t) => object(t) && typeof t.id === 'string' && typeof t.projectId === 'string' && typeof t.brief === 'string' &&
    typeof t.cwd === 'string' && strings(t.acceptanceCriteria) && strings(t.assignedSessionIds) && strings(t.dependsOn) &&
    ['planned', 'running', 'blocked', 'ready-for-review', 'accepted', 'cancelled'].includes(String(t.state)) && time(t.createdAt) && time(t.updatedAt) &&
    (t.submissionId === undefined || typeof t.submissionId === 'string') && Array.isArray(t.requiredChecks) && t.requiredChecks.every((c) => object(c) && typeof c.id === 'string' && typeof c.command === 'string' && typeof c.cwd === 'string') &&
    Array.isArray(t.acceptances) && t.acceptances.every((a) => object(a) && a.by === 'human' && typeof a.submissionId === 'string' && time(a.at) && revision(a.revision))) &&
    v.attempts.every((a) => object(a) && typeof a.id === 'string' && typeof a.taskId === 'string' && typeof a.sessionId === 'string' && time(a.startedAt) && revision(a.revision) &&
      (a.kind === 'agent-report' ? typeof a.summary === 'string' && time(a.endedAt) : a.kind === 'command' && typeof a.checkId === 'string' && typeof a.command === 'string' && typeof a.cwd === 'string' && typeof a.outputRef === 'string' &&
        (a.endedAt === null || time(a.endedAt)) && (a.exitCode === null || Number.isInteger(a.exitCode)) && ['running', 'passed', 'failed', 'interrupted'].includes(String(a.status)) &&
        (a.endRevision === undefined || revision(a.endRevision)) && (a.error === undefined || typeof a.error === 'string')))
}

export function recoverTasks(records: TaskRecords, now = Date.now()): TaskRecords {
  const interrupted = new Set(records.attempts.filter((a) => a.kind === 'command' && a.status === 'running').map((a) => a.taskId))
  if (!interrupted.size) return records
  return {
    tasks: records.tasks.map((t) => interrupted.has(t.id) && t.state !== 'cancelled' ? { ...t, state: 'blocked', updatedAt: now } : t),
    attempts: records.attempts.map((a) => a.kind === 'command' && a.status === 'running' ? { ...a, status: 'interrupted', endedAt: now, error: 'App stopped before completion was recorded; run a new attempt' } : a)
  }
}
