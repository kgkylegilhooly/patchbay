import type { CanvasStore } from '../../shared/contract'
import type { CanvasDoc } from '../../shared/model'
import type { BrowserAttempt } from '../../shared/browserEvidence'
import type { TaskBrowserCheck } from '../../shared/task'
import { unknownRevision } from '../tasks/verification'

/** Why `--task-id` can't be used for a browser in this project, or null when it can. */
export function taskRefusal(doc: CanvasDoc, projectId: string | undefined, taskId: string): string | null {
  const task = doc.projects.find((p) => p.id === projectId)?.tasks?.tasks.find((t) => t.id === taskId)
  if (!task) return `There is no task "${taskId}" in this browser's project. patchbay task list shows them.`
  if (task.state === 'cancelled') return `Task "${taskId}" is cancelled, so evidence can't be added to it.`
  return null
}

/** The task's own record of a browser attempt: what it was, how it ended and what the agent claimed. */
export function taskRecordOf(attempt: BrowserAttempt): TaskBrowserCheck | null {
  if (!attempt.taskId) return null
  return {
    kind: 'browser',
    id: `browser-${attempt.id}`,
    taskId: attempt.taskId,
    sessionId: attempt.startedBy?.id ?? 'unknown',
    startedAt: attempt.startedAt,
    endedAt: attempt.state === 'recording' ? null : (attempt.finishedAt ?? null),
    nodeId: attempt.nodeId,
    browserAttemptId: attempt.id,
    url: attempt.url,
    state: attempt.state,
    assertion: attempt.assertion,
    gaps: attempt.gaps.length,
    revision: attempt.revision ?? unknownRevision('not recorded')
  }
}

/**
 * Lists a browser attempt on the task it's evidence for, as it starts and again as it ends. A task that has gone since
 * is left alone. Readiness doesn't count these: an agent's browser check is a claim, not a passing check.
 */
export function linkAttemptToTask(store: CanvasStore, attempt: BrowserAttempt): void {
  const record = taskRecordOf(attempt)
  if (!record || !attempt.projectId) return
  const records = store.get().projects.find((p) => p.id === attempt.projectId)?.tasks
  if (!records?.tasks.some((t) => t.id === record.taskId)) return
  const at = records.attempts.findIndex((a) => a.id === record.id)
  const attempts = at < 0 ? [...records.attempts, record] : records.attempts.map((a, i) => (i === at ? record : a))
  store.dispatch({ op: 'setTasks', projectId: attempt.projectId, tasks: { ...records, attempts } })
}
