import { currentAttempt } from '../../core/workflow/engine'
import type { RunState, StepAttempt, WorkflowRun } from '../../shared/workflow'
import { attemptLook, workflowRunLook } from '../status/status'

/** How a run and its steps read in the panel. Pure, so it's tested without a page. The words are the status system's. */

const RUN_STATES: RunState[] = ['running', 'waiting-for-you', 'succeeded', 'failed', 'stopped', 'needs-attention']
export const RUN_STATE_LABEL = Object.fromEntries(RUN_STATES.map((s) => [s, workflowRunLook(s).label])) as Record<RunState, string>

const ATTEMPT_STATES: (StepAttempt['state'] | 'pending')[] = ['pending', 'launching', 'running', 'waiting-for-you', 'succeeded', 'failed', 'interrupted', 'superseded']
export const ATTEMPT_LABEL = Object.fromEntries(ATTEMPT_STATES.map((s) => [s, attemptLook(s).label])) as Record<StepAttempt['state'] | 'pending', string>

/** The strip text: "Step 3 of 5 · Tests running", or how it ended. */
export function runStrip(run: WorkflowRun): string {
  const steps = run.definition.steps
  if (run.state === 'succeeded') return `All ${steps.length} steps done`
  if (run.state === 'stopped') return 'Stopped'
  const i = steps.findIndex((s) => currentAttempt(run, s.key)?.state !== 'succeeded')
  if (i < 0) return RUN_STATE_LABEL[run.state]
  const a = currentAttempt(run, steps[i].key)
  const what = attemptLook(a?.state ?? 'pending', a?.idle).label.toLowerCase()
  return `Step ${i + 1} of ${steps.length} · ${steps[i].title} ${what}`
}

/** The input shown with a run's name: its first text input, shortened. */
export function runSubject(run: WorkflowRun): string {
  const text = run.definition.inputs.map((i) => run.inputs[i.key]).find((v): v is string => typeof v === 'string' && !!v.trim())
  return text ? (text.length > 60 ? `${text.slice(0, 59)}…` : text) : ''
}

/** Runs worth a chip: anything not finished, and runs that finished in the last `recentMs`. */
export function chipRuns(runs: WorkflowRun[], now: number, recentMs = 10 * 60_000): WorkflowRun[] {
  return runs.filter((r) => !['succeeded', 'stopped'].includes(r.state) || (r.endedAt !== undefined && now - r.endedAt < recentMs))
}

/** Whether a run wants the person now. */
export const needsPerson = (run: WorkflowRun): boolean => ['waiting-for-you', 'failed', 'needs-attention'].includes(run.state)

/** Earlier attempts of a step, newest first, for the history under it. */
export function earlierAttempts(run: WorkflowRun, step: string): StepAttempt[] {
  const current = currentAttempt(run, step)
  return run.attempts.filter((a) => a.step === step && a.id !== current?.id).sort((a, b) => b.n - a.n)
}
