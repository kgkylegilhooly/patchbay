/**
 * Comparisons started for a P1 task. The two attempts are listed on the task, each verification run is recorded as
 * the command it was, with its output, exit code and git identity, and choosing an attempt is recorded on the task.
 * Nothing here merges anything or accepts a task: acceptance stays the person's action on the board or in the review
 * inbox. Pure, so it can be tested without git or a window. See docs/plans/followups-integration.md.
 */
import type { Attempt, AttemptKey, Comparison, VerifyResult } from './compare'
import type { Task, TaskAttempt, TaskComparisonAttempt, TaskRecords, TaskRevision, TaskVerification } from './task'

/** Why a comparison can't be started for this task, or null when it can. */
export function taskComparisonRefusal(records: TaskRecords | undefined, taskId: string): string | null {
  const task = records?.tasks.find((t) => t.id === taskId)
  if (!task) return 'That task is not in this project any more.'
  if (task.state === 'cancelled') return 'That task is cancelled, so nothing new can be added to it.'
  if (task.state === 'accepted') return 'That task is already accepted. Set it running again before trying other approaches for it.'
  return null
}

/** The brief a comparison for a task starts from: the task's brief and its acceptance criteria. */
export function taskComparisonBrief(task: Pick<Task, 'brief' | 'acceptanceCriteria'>): string {
  const criteria = task.acceptanceCriteria.filter((c) => c.trim())
  return criteria.length ? `${task.brief.trim()}\n\nAcceptance criteria:\n${criteria.map((c) => `- ${c.trim()}`).join('\n')}` : task.brief.trim()
}

export const comparisonAttemptId = (comparisonId: string, key: AttemptKey): string => `comparison-${comparisonId}-${key}`

/** The task's record of one attempt, made as the attempt starts. */
export function comparisonAttemptRecord(c: Comparison, a: Attempt, taskId: string): TaskComparisonAttempt {
  return {
    kind: 'comparison',
    id: comparisonAttemptId(c.id, a.key),
    taskId,
    sessionId: a.nodeId,
    startedAt: c.createdAt,
    comparisonId: c.id,
    key: a.key,
    title: c.title,
    agent: a.agent,
    branch: a.branch,
    path: a.path,
    base: c.base.commit,
    revision: { revision: c.base.commit, uncommitted: false, fingerprint: null, reason: 'the commit this attempt started from' }
  }
}

/** The check id a comparison run is recorded under. Never one a task declares: it never stands in for one. */
export const comparisonCheckId = (key: AttemptKey): string => `comparison ${key.toUpperCase()}`

/**
 * A comparison's verification run, as the task's command evidence. The command is the argument list joined by spaces,
 * which loses nothing: verification arguments can't hold spaces or quotes (shared/compare.ts verifyArgv).
 */
export function comparisonRunRecord(o: {
  id: string
  comparison: Comparison
  attempt: Attempt
  taskId: string
  result: VerifyResult
  outputRef: string
  revision: TaskRevision
  endRevision: TaskRevision
}): TaskVerification {
  const r = o.result
  const passed = r.exitCode === 0 && !r.timedOut && !r.missing
  const error = r.missing ? 'The program could not be started' : r.timedOut ? 'The command exceeded the verification time limit' : undefined
  return {
    kind: 'command',
    id: o.id,
    taskId: o.taskId,
    sessionId: o.attempt.nodeId,
    checkId: comparisonCheckId(o.attempt.key),
    command: r.argv.join(' '),
    cwd: r.cwd,
    startedAt: r.startedAt,
    endedAt: r.startedAt + r.durationMs,
    exitCode: r.exitCode,
    status: passed ? 'passed' : 'failed',
    outputRef: o.outputRef,
    revision: o.revision,
    endRevision: o.endRevision,
    ...(error ? { error } : {}),
    comparison: { id: o.comparison.id, key: o.attempt.key }
  }
}

/** The saved output file's text, laid out as a task's own check output is (src/main/tasks/verification.ts). */
export function comparisonRunOutput(r: VerifyResult, label: string): string {
  const end = new Date(r.startedAt + r.durationMs).toISOString()
  const cut = r.truncated ? `[Only the last part of the output was kept${r.totalBytes ? `, of ${r.totalBytes} bytes` : ''}.]\n` : ''
  const why = r.missing ? 'The program could not be started.\n' : r.timedOut ? 'The command exceeded the verification time limit.\n' : ''
  return `Command: ${r.argv.join(' ')}\nCwd: ${r.cwd}\nRun for: ${label}\nStarted: ${new Date(r.startedAt).toISOString()}\n\n${cut}${r.output}\nEnded: ${end}\nExit: ${r.exitCode}\n${why}`
}

/** Adds or replaces one attempt record by id. */
export function putAttempt(records: TaskRecords, attempt: TaskAttempt): TaskRecords {
  const at = records.attempts.findIndex((a) => a.id === attempt.id)
  return { ...records, attempts: at < 0 ? [...records.attempts, attempt] : records.attempts.map((a, i) => (i === at ? attempt : a)) }
}

/**
 * Records the person's choice on the task: the chosen attempt is marked, the comparison's other attempt is not. Null
 * clears it. Records of other comparisons are left alone. Returns the records unchanged when nothing was marked.
 */
export function withComparisonChoice(records: TaskRecords, taskId: string, comparisonId: string, choice: { key: AttemptKey; at: number; head: string | null } | null): TaskRecords {
  let changed = false
  const attempts = records.attempts.map((a) => {
    if (a.kind !== 'comparison' || a.taskId !== taskId || a.comparisonId !== comparisonId) return a
    const { chosen: _was, ...rest } = a
    changed = true
    return choice && a.key === choice.key ? { ...rest, chosen: { at: choice.at, head: choice.head } } : rest
  })
  return changed ? { ...records, attempts } : records
}

/** One comparison as a task shows it: its attempts, each with its latest recorded run, and which one was chosen. */
export interface TaskComparisonView {
  comparisonId: string
  title: string
  base: string
  attempts: { record: TaskComparisonAttempt; run?: TaskVerification; runs: number }[]
  chosen?: TaskComparisonAttempt
}

/** A task's comparisons, newest first, from its attempt records alone. */
export function taskComparisons(attempts: TaskAttempt[]): TaskComparisonView[] {
  const byId = new Map<string, TaskComparisonView>()
  for (const a of attempts) {
    if (a.kind !== 'comparison') continue
    const view = byId.get(a.comparisonId) ?? { comparisonId: a.comparisonId, title: a.title, base: a.base, attempts: [] }
    const runs = attempts.filter((r): r is TaskVerification => r.kind === 'command' && r.comparison?.id === a.comparisonId && r.comparison.key === a.key)
    view.attempts.push({ record: a, ...(runs.length ? { run: runs.at(-1) } : {}), runs: runs.length })
    if (a.chosen) view.chosen = a
    byId.set(a.comparisonId, view)
  }
  return [...byId.values()]
    .map((v) => ({ ...v, attempts: [...v.attempts].sort((x, y) => x.record.key.localeCompare(y.record.key)) }))
    .sort((x, y) => (y.attempts[0]?.record.startedAt ?? 0) - (x.attempts[0]?.record.startedAt ?? 0))
}
