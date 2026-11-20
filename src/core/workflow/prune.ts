import type { WorkflowRun } from '../../shared/workflow'

/** How much finished run data is kept. */
export interface PruneLimits {
  /** Finished runs older than this go, with their kept files. */
  maxAgeMs: number
  /** Past this many bytes of kept files in all, the oldest finished runs go first. */
  maxBytes: number
}

export const DEFAULT_PRUNE: PruneLimits = { maxAgeMs: 90 * 24 * 60 * 60_000, maxBytes: 2 * 1024 * 1024 * 1024 }

/** A run that is over: it succeeded or was stopped. A failed run can still be retried, so it is still open. */
export const isFinished = (run: WorkflowRun): boolean => run.state === 'succeeded' || run.state === 'stopped'

/**
 * Which runs to delete, with their files. Never one that's still open, and never one whose deliverable task still
 * needs its files (the task's check evidence is the run's log). Of the rest: those finished longer ago than the age
 * limit, then the oldest finished first until the kept files fit the size limit. Pure: the caller measures sizes and
 * reads tasks.
 */
export function planPrune(
  runs: ReadonlyArray<{ run: WorkflowRun; bytes: number }>,
  now: number,
  limits: PruneLimits,
  taskNeeds: (run: WorkflowRun) => boolean
): string[] {
  const removable = (run: WorkflowRun): boolean => isFinished(run) && !taskNeeds(run)
  const ended = (run: WorkflowRun): number => run.endedAt ?? run.startedAt
  const gone = new Set(runs.filter(({ run }) => removable(run) && now - ended(run) > limits.maxAgeMs).map(({ run }) => run.id))
  let total = runs.filter(({ run }) => !gone.has(run.id)).reduce((n, r) => n + r.bytes, 0)
  const oldestFirst = runs.filter(({ run }) => removable(run) && !gone.has(run.id)).sort((a, b) => ended(a.run) - ended(b.run))
  for (const { run, bytes } of oldestFirst) {
    if (total <= limits.maxBytes) break
    gone.add(run.id)
    total -= bytes
  }
  return runs.filter(({ run }) => gone.has(run.id)).map(({ run }) => run.id)
}
