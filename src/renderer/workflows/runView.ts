import { currentAttempt } from '../../core/workflow/engine'
import type { RunState, StepAttempt, WorkflowRun } from '../../shared/workflow'

/** How a run and its steps read in the panel. Pure, so it's tested without a page. */

export const RUN_STATE_LABEL: Record<RunState, string> = {
  running: 'Running',
  'waiting-for-you': 'Waiting for you',
  succeeded: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  'needs-attention': 'Needs you'
}

export const ATTEMPT_LABEL: Record<StepAttempt['state'] | 'pending', string> = {
  pending: 'Not yet',
  launching: 'Starting',
  running: 'Running',
  'waiting-for-you': 'Waiting for you',
  succeeded: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
  superseded: 'Replaced'
}

/** The strip text: "Step 3 of 5 · Tests running", or how it ended. */
export function runStrip(run: WorkflowRun): string {
  const steps = run.definition.steps
  if (run.state === 'succeeded') return `All ${steps.length} steps done`
  if (run.state === 'stopped') return 'Stopped'
  const i = steps.findIndex((s) => currentAttempt(run, s.key)?.state !== 'succeeded')
  if (i < 0) return RUN_STATE_LABEL[run.state]
  const a = currentAttempt(run, steps[i].key)
  const what = a?.idle ? 'idle, no result' : a?.state === 'waiting-for-you' ? 'waiting for you' : (ATTEMPT_LABEL[a?.state ?? 'pending']).toLowerCase()
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
