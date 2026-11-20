import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Attempt, AttemptKey, Comparison, VerifyResult } from '../../shared/compare'
import { attemptLabel } from '../../shared/compare'
import type { CanvasStore } from '../../shared/contract'
import type { TaskRecords, TaskRevision } from '../../shared/task'
import { comparisonAttemptRecord, comparisonRunOutput, comparisonRunRecord, putAttempt, taskComparisonRefusal, withComparisonChoice } from '../../shared/taskCompare'
import { readRevision } from '../tasks/verification'

/**
 * Writes a comparison's part into the task it was started for: its attempts, its verification runs as command
 * evidence and the person's choice. A task that has gone since is left alone, and the comparison carries on without
 * it. Never changes a task's state and never accepts. See src/shared/taskCompare.ts.
 */
export interface CompareTaskLink {
  /** Why a comparison can't be started for this task, or null. */
  refusal(projectId: string, taskId: string): string | null
  /** The folder's git identity, as task evidence records it. */
  revision(path: string): Promise<TaskRevision>
  started(c: Comparison, a: Attempt): void
  /** Records one verification run, with its output saved as a task check's is. */
  verified(c: Comparison, a: Attempt, result: VerifyResult, before: TaskRevision): Promise<void>
  chosen(c: Comparison, choice: { key: AttemptKey; at: number; head: string | null } | null): void
}

export function createCompareTaskLink(d: { store: CanvasStore; dataDir: string; persist?: () => Promise<void>; revision?: (cwd: string) => Promise<TaskRevision>; newId?: () => string }): CompareTaskLink {
  const revision = d.revision ?? readRevision
  const newId = d.newId ?? randomUUID
  const records = (projectId: string): TaskRecords | undefined => d.store.get().projects.find((p) => p.id === projectId)?.tasks
  /** Applies a change to the comparison's task, if it's still there. */
  const change = (c: Comparison, fn: (r: TaskRecords, taskId: string) => TaskRecords): void => {
    const taskId = c.taskId
    if (!taskId) return
    const current = records(c.projectId)
    if (!current?.tasks.some((t) => t.id === taskId)) return
    const next = fn(current, taskId)
    if (next === current) return
    d.store.dispatch({ op: 'setTasks', projectId: c.projectId, tasks: next })
    void d.persist?.().catch(() => undefined)
  }
  return {
    refusal: (projectId, taskId) => taskComparisonRefusal(records(projectId), taskId),
    revision,
    started(c, a) {
      change(c, (r, taskId) => putAttempt(r, comparisonAttemptRecord(c, a, taskId)))
    },
    async verified(c, a, result, before) {
      if (!c.taskId || !records(c.projectId)?.tasks.some((t) => t.id === c.taskId)) return
      const endRevision = await revision(a.path)
      const id = newId()
      const dir = join(d.dataDir, 'task-output')
      await mkdir(dir, { recursive: true })
      const outputRef = join(dir, `${id}.log`)
      await writeFile(outputRef, comparisonRunOutput(result, `attempt ${attemptLabel(a.key)} of the comparison "${c.title}"`), 'utf8')
      change(c, (r, taskId) => putAttempt(r, comparisonRunRecord({ id, comparison: c, attempt: a, taskId, result, outputRef, revision: before, endRevision })))
    },
    chosen(c, choice) {
      change(c, (r, taskId) => withComparisonChoice(r, taskId, c.id, choice))
    }
  }
}
