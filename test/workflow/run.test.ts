import { describe, expect, test } from 'vitest'
import { applyRunEvent, attemptId, createRun, deriveRunState, latestAttempt, readyJobs, recoverRun, resolveInputs, type RunEvent } from '../../src/core/workflow/run'
import { BUILT_IN_ACTIONS } from '../../src/core/workflow/catalog'
import type { Value, WorkflowRun } from '../../src/shared/workflow'
import { featureRevision, featureWorkflow, repo } from './fixtures'

const planFile = { kind: 'file' as const, path: 'plan.md', sha256: 'p1' }
const log = { kind: 'file' as const, path: 'tests.log' }

function start(inputs: Record<string, unknown> = { repo, brief: 'Add dark mode' }): WorkflowRun {
  const r = createRun({ revision: featureRevision(), inputs, runId: 'r1', now: 1 })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.run
}

let clock = 10
function apply(run: WorkflowRun, event: RunEvent): WorkflowRun {
  const t = applyRunEvent(run, event, clock++)
  if (!t.ok) throw new Error(`${event.type}: ${t.code} ${t.message}`)
  return t.run
}
function refuse(run: WorkflowRun, event: RunEvent) {
  const t = applyRunEvent(run, event, clock++)
  expect(t.ok).toBe(false)
  return t.ok ? null! : t
}

/** Enqueues, dispatches and starts the next ready job. */
function launch(run: WorkflowRun, jobId: string): WorkflowRun {
  expect(readyJobs(run)).toEqual([jobId])
  run = apply(run, { type: 'enqueue', jobId })
  const id = latestAttempt(run, jobId)!.id
  run = apply(run, { type: 'dispatching', attemptId: id })
  return apply(run, { type: 'started', attemptId: id, correlation: { sessionId: `s-${jobId}` } })
}
const current = (run: WorkflowRun, jobId: string) => latestAttempt(run, jobId)!.id
function finish(run: WorkflowRun, jobId: string, by: 'agent' | 'adapter' | 'person', outputs: Record<string, Value>): WorkflowRun {
  return apply(run, { type: 'submit', jobId, attemptId: current(run, jobId), by, outputs })
}

/** Runs the proving workflow up to and including the tests job. */
function throughApproval(): WorkflowRun {
  let run = launch(start(), 'plan')
  run = finish(run, 'plan', 'agent', { summary: 'Planned', plan: planFile })
  run = launch(run, 'approve')
  run = apply(run, { type: 'wait', attemptId: current(run, 'approve'), reason: 'human-review' })
  expect(run.state).toBe('waiting-for-user')
  return finish(run, 'approve', 'person', { approved: true, feedback: 'Keep it small' })
}

describe('starting a run', () => {
  test('applies defaults and pins a copy of the definition', () => {
    const run = start()
    expect(run).toMatchObject({ state: 'queued', revision: 1, workflowId: 'feature', attempts: [] })
    expect(run.inputs).toEqual({ repo, brief: 'Add dark mode', implementer: 'codex' })
    expect(Object.isFrozen(run.definition)).toBe(false) // A copy, not the frozen revision.
  })

  test('missing, wrong and unknown inputs are refused with useful messages', () => {
    const r = createRun({ revision: featureRevision(), inputs: { brief: 5, implementer: 'gemini', colour: 'red' }, runId: 'r', now: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.map((i) => i.message)).toEqual([
      'This workflow has no input called "colour". Its inputs are: repo, brief, implementer, testArgs.',
      '"Repository" is required.',
      '"Feature brief" must be text.',
      '"Implementer" "gemini" isn\'t one of the choices (claude, codex).'
    ])
  })

  test('a revision whose action has since become unavailable doesn\'t start', () => {
    const catalog = BUILT_IN_ACTIONS.map((a) => (a.id === 'agent' ? { ...a, unavailable: 'Both agents are turned off in Settings.' } : a))
    const r = createRun({ revision: featureRevision(), inputs: { repo, brief: 'x' }, runId: 'r', now: 0, catalog })
    expect(r.ok).toBe(false)
  })

  test('editing the definition after the start leaves the run as it was', () => {
    const def = featureWorkflow()
    const r = createRun({ revision: featureRevision(def), inputs: { repo, brief: 'x' }, runId: 'r', now: 0 })
    def.jobs[0].name = 'Something else'
    def.jobs.pop()
    expect(r.ok && r.run.definition.jobs.map((j) => j.name)).toEqual(['Plan', 'Approve plan', 'Implement', 'Integration tests', 'Review'])
  })
})

describe('running the proving workflow', () => {
  test('one job at a time, explicit outputs reaching the next job, ending in success', () => {
    let run = throughApproval()
    run = launch(run, 'implement')
    const implement = resolveInputs(run, 'implement')
    expect(implement.ok && implement.values.instructions).toEqual({
      value: 'Implement plan.md. Feedback: Keep it small',
      from: [{ runId: 'r1', jobId: 'plan', attemptId: 'r1:plan:1' }, { runId: 'r1', jobId: 'approve', attemptId: 'r1:approve:1' }]
    })
    expect(implement.ok && implement.values.agent.value).toBe('codex')
    run = finish(run, 'implement', 'agent', { summary: 'Did it' })
    run = launch(run, 'tests')
    const tests = resolveInputs(run, 'tests')
    // The optional extra arguments were left empty, so they're left out rather than passed as "".
    expect(tests.ok && tests.values.args.value).toEqual(['test'])
    run = finish(run, 'tests', 'adapter', { exitCode: 0, log })
    run = launch(run, 'review')
    expect(resolveInputs(run, 'review').ok && (resolveInputs(run, 'review') as { values: Record<string, { value: Value }> }).values.agent.value).toBe('claude')
    run = finish(run, 'review', 'agent', { summary: 'Looks good', verdict: 'ship' })
    expect(run.state).toBe('succeeded')
    expect(readyJobs(run)).toEqual([])
  })

  test('nothing downstream is ready until a result is submitted; activity alone does nothing', () => {
    const run = launch(start(), 'plan')
    expect(run.state).toBe('running')
    expect(readyJobs(run)).toEqual([])
  })

  test('a result that doesn\'t match the declared outputs is refused and the attempt keeps running', () => {
    const run = launch(start(), 'plan')
    const t = refuse(run, { type: 'submit', jobId: 'plan', attemptId: current(run, 'plan'), by: 'agent', outputs: { summary: 'x', plan: 'plan.md', extra: 1 } })
    expect(t.code).toBe('bad-outputs')
    expect(t.message).toBe('The result for "Plan" doesn\'t match its outputs: "plan" must be a file; "extra" isn\'t one of this job\'s outputs (summary, plan).')
    expect(latestAttempt(run, 'plan')!.state).toBe('running')
    const missing = refuse(run, { type: 'submit', jobId: 'plan', attemptId: current(run, 'plan'), by: 'agent', outputs: { summary: 'x' } })
    expect(missing.message).toContain('"plan" is missing')
  })

  test('a failing command stops progression', () => {
    let run = throughApproval()
    run = launch(run, 'implement')
    run = finish(run, 'implement', 'agent', { summary: 'Did it' })
    run = launch(run, 'tests')
    run = finish(run, 'tests', 'adapter', { exitCode: 1, log })
    expect(latestAttempt(run, 'tests')).toMatchObject({ state: 'failed', error: 'exitCode was 1, not 0', outputs: { exitCode: 1, log } })
    expect(run.state).toBe('failed')
    expect(readyJobs(run)).toEqual([])
    expect(refuse(run, { type: 'enqueue', jobId: 'review' }).code).toBe('not-ready')
  })

  test('a rejected plan stops the run, with the feedback kept', () => {
    let run = launch(start(), 'plan')
    run = finish(run, 'plan', 'agent', { summary: 'Planned', plan: planFile })
    run = launch(run, 'approve')
    run = finish(run, 'approve', 'person', { approved: false, feedback: 'Too big' })
    expect(latestAttempt(run, 'approve')).toMatchObject({ state: 'failed', outputs: { approved: false, feedback: 'Too big' } })
    expect(run.state).toBe('failed')
  })

  test('an adapter failure fails the attempt', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'fail', jobId: 'plan', attemptId: current(run, 'plan'), by: 'agent', error: 'Could not plan' })
    expect(run.state).toBe('failed')
  })
})

describe('who can report a result', () => {
  test('an agent can\'t record a person\'s decision, and a person can\'t stand in for a command', () => {
    let run = launch(start(), 'plan')
    run = finish(run, 'plan', 'agent', { summary: 'Planned', plan: planFile })
    run = launch(run, 'approve')
    const t = refuse(run, { type: 'submit', jobId: 'approve', attemptId: current(run, 'approve'), by: 'agent', outputs: { approved: true } })
    expect(t).toMatchObject({ code: 'not-allowed', message: 'Only a person can report the result of "Approve plan" (Human review).' })
    expect(refuse(run, { type: 'fail', jobId: 'approve', attemptId: current(run, 'approve'), by: 'agent', error: 'x' }).code).toBe('not-allowed')
  })

  test('a result can\'t land on a sibling job', () => {
    const run = launch(start(), 'plan')
    const t = refuse(run, { type: 'submit', jobId: 'implement', attemptId: current(run, 'plan'), by: 'agent', outputs: { summary: 'x' } })
    expect(t.code).toBe('wrong-job')
  })

  test('a result for an attempt that doesn\'t exist', () => {
    expect(refuse(start(), { type: 'submit', jobId: 'plan', attemptId: 'r1:plan:9', by: 'agent', outputs: {} }).code).toBe('unknown-attempt')
  })

  test('a result before the attempt started', () => {
    const run = apply(start(), { type: 'enqueue', jobId: 'plan' })
    expect(refuse(run, { type: 'submit', jobId: 'plan', attemptId: 'r1:plan:1', by: 'agent', outputs: { summary: 'x', plan: planFile } }).code).toBe('bad-state')
  })
})

describe('duplicate and stale reports', () => {
  test('a second result for a finished attempt is refused and changes nothing', () => {
    let run = launch(start(), 'plan')
    run = finish(run, 'plan', 'agent', { summary: 'First', plan: planFile })
    const t = refuse(run, { type: 'submit', jobId: 'plan', attemptId: 'r1:plan:1', by: 'agent', outputs: { summary: 'Second', plan: planFile } })
    expect(t.code).toBe('duplicate')
    expect(latestAttempt(run, 'plan')!.outputs!.summary).toBe('First')
  })

  test('a late result from a replaced attempt can\'t complete the retry', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'interrupt', attemptId: 'r1:plan:1', reason: 'Session closed' })
    expect(run.state).toBe('interrupted')
    run = apply(run, { type: 'retry', jobId: 'plan', by: 'person' })
    expect(latestAttempt(run, 'plan')).toMatchObject({ id: 'r1:plan:2', number: 2, state: 'queued' })
    const t = refuse(run, { type: 'submit', jobId: 'plan', attemptId: 'r1:plan:1', by: 'agent', outputs: { summary: 'Late', plan: planFile } })
    expect(t.code).toBe('stale')
    // Both attempts are kept.
    expect(run.attempts.filter((a) => a.jobId === 'plan').map((a) => a.state)).toEqual(['interrupted', 'queued'])
  })

  test('an attempt can only be handed to its adapter once, so a launch is never repeated', () => {
    let run = apply(start(), { type: 'enqueue', jobId: 'plan' })
    run = apply(run, { type: 'dispatching', attemptId: 'r1:plan:1' })
    expect(refuse(run, { type: 'dispatching', attemptId: 'r1:plan:1' }).code).toBe('duplicate')
    expect(refuse(run, { type: 'enqueue', jobId: 'plan' }).code).toBe('not-ready')
  })
})

describe('retries', () => {
  test('only failed or interrupted jobs can be retried', () => {
    const run = launch(start(), 'plan')
    expect(refuse(run, { type: 'retry', jobId: 'plan', by: 'person' }).code).toBe('bad-state')
    expect(refuse(run, { type: 'retry', jobId: 'implement', by: 'person' }).code).toBe('bad-state')
    expect(refuse(run, { type: 'retry', jobId: 'nope', by: 'person' }).code).toBe('unknown-job')
  })

  test('automatic retries keep to the job\'s limit; a person can always retry', () => {
    let run = throughApproval()
    run = launch(run, 'implement')
    run = finish(run, 'implement', 'agent', { summary: 'Did it' })
    run = launch(run, 'tests')
    const failTests = (r: WorkflowRun) => finish(apply(apply(r, { type: 'dispatching', attemptId: current(r, 'tests') }), { type: 'started', attemptId: current(r, 'tests') }), 'tests', 'adapter', { exitCode: 2, log })
    run = finish(run, 'tests', 'adapter', { exitCode: 2, log })
    run = apply(run, { type: 'retry', jobId: 'tests', by: 'auto' }) // limits.retries is 1
    run = failTests(run)
    expect(refuse(run, { type: 'retry', jobId: 'tests', by: 'auto' })).toMatchObject({ code: 'retry-limit', message: '"Integration tests" has used its 1 automatic retry.' })
    run = apply(run, { type: 'retry', jobId: 'tests', by: 'person' })
    expect(run.state).toBe('running')
    run = apply(run, { type: 'dispatching', attemptId: current(run, 'tests') })
    run = apply(run, { type: 'started', attemptId: current(run, 'tests') })
    run = finish(run, 'tests', 'adapter', { exitCode: 0, log })
    expect(readyJobs(run)).toEqual(['review'])
    expect(run.attempts.filter((a) => a.jobId === 'tests').map((a) => a.state)).toEqual(['failed', 'failed', 'succeeded'])
  })

  test('a job is given the outputs of its dependency\'s latest successful attempt', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'fail', jobId: 'plan', attemptId: 'r1:plan:1', by: 'agent', error: 'x' })
    run = apply(run, { type: 'retry', jobId: 'plan', by: 'person' })
    run = apply(run, { type: 'started', attemptId: 'r1:plan:2' })
    run = finish(run, 'plan', 'agent', { summary: 'Second', plan: { kind: 'file', path: 'plan2.md' } })
    const r = resolveInputs(run, 'approve')
    expect(r.ok && r.values.material).toEqual({ value: 'plan2.md', from: [{ runId: 'r1', jobId: 'plan', attemptId: 'r1:plan:2' }] })
  })
})

describe('waiting, pausing and cancelling', () => {
  test('waiting for the person and resuming', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'wait', attemptId: 'r1:plan:1', reason: 'usage-limit' })
    expect(run.state).toBe('waiting-for-user')
    expect(latestAttempt(run, 'plan')!.reason).toBe('usage-limit')
    run = apply(run, { type: 'resume', attemptId: 'r1:plan:1' })
    expect(run.state).toBe('running')
    expect(latestAttempt(run, 'plan')!.reason).toBeUndefined()
    expect(refuse(run, { type: 'resume', attemptId: 'r1:plan:1' }).code).toBe('bad-state')
  })

  test('pause stops new jobs and lets the active one settle', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'pause' })
    expect(run.state).toBe('running') // Plan is still going.
    run = finish(run, 'plan', 'agent', { summary: 'Planned', plan: planFile })
    expect(run.state).toBe('paused')
    expect(readyJobs(run)).toEqual([])
    run = apply(run, { type: 'unpause' })
    expect(readyJobs(run)).toEqual(['approve'])
  })

  test('a paused run doesn\'t hand queued attempts to adapters', () => {
    let run = apply(start(), { type: 'enqueue', jobId: 'plan' })
    run = apply(run, { type: 'pause' })
    expect(refuse(run, { type: 'dispatching', attemptId: 'r1:plan:1' }).code).toBe('not-ready')
  })

  test('cancel stops active attempts, skips the jobs it never reached, and is final', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'cancel', reason: 'Not needed' })
    expect(run.state).toBe('cancelled')
    expect(run.attempts.map((a) => [a.jobId, a.state])).toEqual([
      ['plan', 'cancelled'], ['approve', 'skipped'], ['implement', 'skipped'], ['tests', 'skipped'], ['review', 'skipped']
    ])
    expect(latestAttempt(run, 'review')!.reason).toBe('Not reached: not needed')
    expect(refuse(run, { type: 'submit', jobId: 'plan', attemptId: 'r1:plan:1', by: 'agent', outputs: { summary: 'x', plan: planFile } }).code).toBe('cancelled')
    expect(refuse(run, { type: 'retry', jobId: 'plan', by: 'person' }).code).toBe('cancelled')
    expect(refuse(run, { type: 'pause' }).code).toBe('finished')
    expect(readyJobs(run)).toEqual([])
  })

  test('a finished run can\'t be cancelled', () => {
    let run = throughApproval()
    run = launch(run, 'implement')
    run = finish(run, 'implement', 'agent', { summary: 'x' })
    run = launch(run, 'tests')
    run = finish(run, 'tests', 'adapter', { exitCode: 0, log })
    run = launch(run, 'review')
    run = finish(run, 'review', 'agent', { summary: 'x', verdict: 'fix' })
    expect(refuse(run, { type: 'cancel' }).code).toBe('finished')
  })
})

describe('recovery after a restart', () => {
  test('recorded but never handed over: still queued, safe to launch', () => {
    const run = apply(start(), { type: 'enqueue', jobId: 'plan' })
    expect(recoverRun(run, 99)).toBe(run)
  })

  test('handed over but never reported started: interrupted, not relaunched', () => {
    let run = apply(start(), { type: 'enqueue', jobId: 'plan' })
    run = apply(run, { type: 'dispatching', attemptId: 'r1:plan:1' })
    const after = recoverRun(run, 99)
    expect(latestAttempt(after, 'plan')).toMatchObject({ state: 'interrupted', endedAt: 99 })
    expect(latestAttempt(after, 'plan')!.reason).toMatch(/may or may not have started/)
    expect(after.state).toBe('interrupted')
    expect(readyJobs(after)).toEqual([])
  })

  test('started but no result recorded: interrupted unless its adapter reports it alive', () => {
    const run = launch(start(), 'plan')
    expect(latestAttempt(recoverRun(run, 99), 'plan')!.state).toBe('interrupted')
    expect(recoverRun(run, 99, new Set(['r1:plan:1']))).toBe(run)
  })

  test('a decision still waiting for the person keeps waiting', () => {
    let run = launch(start(), 'plan')
    run = finish(run, 'plan', 'agent', { summary: 'Planned', plan: planFile })
    run = launch(run, 'approve')
    run = apply(run, { type: 'wait', attemptId: current(run, 'approve'), reason: 'human-review' })
    expect(recoverRun(run, 99)).toBe(run)
  })

  test('success is never assumed', () => {
    let run = launch(start(), 'plan')
    run = apply(run, { type: 'wait', attemptId: 'r1:plan:1', reason: 'usage-limit' })
    const after = recoverRun(run, 99)
    expect(after.attempts.some((a) => a.state === 'succeeded')).toBe(false)
  })
})

describe('purity', () => {
  test('events never change the run they are given', () => {
    const run = launch(start(), 'plan')
    const before = structuredClone(run)
    applyRunEvent(run, { type: 'submit', jobId: 'plan', attemptId: 'r1:plan:1', by: 'agent', outputs: { summary: 'x', plan: planFile } }, 50)
    applyRunEvent(run, { type: 'cancel' }, 50)
    recoverRun(run, 50)
    expect(run).toEqual(before)
  })

  test('state is derived from attempts', () => {
    const run = start()
    expect(deriveRunState(run)).toBe('queued')
    expect(attemptId('r', 'j', 3)).toBe('r:j:3')
  })
})
