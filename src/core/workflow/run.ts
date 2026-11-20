import {
  SETTLED_ATTEMPT, WORKFLOW_SCHEMA, type Binding, type DefinitionRevision, type JobAttempt, type OutputSpec, type Provenance,
  type RunState, type ValidationIssue, type Value, type WorkflowJob, type WorkflowRun
} from '../../shared/workflow'
import { BUILT_IN_ACTIONS, checkValue, findAction, type ActionCatalog, type Submitter } from './catalog'
import { executionOrder, dependencyGraph } from './plan'
import { jobOutputs, validateDefinition } from './validate'

/**
 * The pure core of running a workflow: what may happen next, and what each report does to a run. No launching, no
 * timers, no files. Every function returns a new run and never changes the one it's given.
 */

export type RunEvent =
  /** The adapter is about to launch the attempt. Recorded first, so a restart knows it might have launched. */
  | { type: 'dispatching'; attemptId: string }
  | { type: 'started'; attemptId: string; correlation?: JobAttempt['correlation'] }
  /** A result. Names the job as well as the attempt, so a result can't land on a sibling. */
  | { type: 'submit'; jobId: string; attemptId: string; by: Submitter; outputs: Record<string, Value> }
  | { type: 'fail'; jobId: string; attemptId: string; by: Submitter; error: string }
  | { type: 'wait'; attemptId: string; reason: string }
  | { type: 'resume'; attemptId: string }
  | { type: 'interrupt'; attemptId: string; reason: string }
  /** Adds the next attempt for a job the planner says is ready. */
  | { type: 'enqueue'; jobId: string }
  /** A new attempt for a failed or interrupted job. A person can always retry; automatic retries keep to the job's limit. */
  | { type: 'retry'; jobId: string; by: 'person' | 'auto' }
  | { type: 'pause' }
  | { type: 'unpause' }
  | { type: 'cancel'; reason?: string }

export type RejectCode =
  | 'unknown-attempt' | 'unknown-job' | 'wrong-job' | 'stale' | 'duplicate' | 'cancelled' | 'finished' | 'bad-state'
  | 'bad-outputs' | 'not-allowed' | 'not-ready' | 'retry-limit'

export type Transition = { ok: true; run: WorkflowRun } | { ok: false; code: RejectCode; message: string }

const ACTIVE: readonly JobAttempt['state'][] = ['queued', 'running', 'waiting-for-user']
const isSettled = (a: JobAttempt): boolean => SETTLED_ATTEMPT.includes(a.state)

export function attemptId(runId: string, jobId: string, number: number): string {
  return `${runId}:${jobId}:${number}`
}

export function latestAttempt(run: WorkflowRun, jobId: string): JobAttempt | undefined {
  let latest: JobAttempt | undefined
  for (const a of run.attempts) if (a.jobId === jobId && (!latest || a.number > latest.number)) latest = a
  return latest
}

function job(run: WorkflowRun, jobId: string): WorkflowJob | undefined {
  return run.definition.jobs.find((j) => j.id === jobId)
}

// Starting a run

/**
 * A new run of a published revision with the person's inputs. Checks the inputs against the form the definition
 * declares, applies defaults, and checks the revision against today's catalog (an action can have become
 * unavailable). The run holds a copy of the whole definition.
 */
export function createRun(p: { revision: DefinitionRevision; inputs: Record<string, unknown>; runId: string; now: number; catalog?: ActionCatalog }):
  { ok: true; run: WorkflowRun } | { ok: false; issues: ValidationIssue[] } {
  const def = p.revision.definition
  const issues: ValidationIssue[] = validateDefinition(def, p.catalog ?? BUILT_IN_ACTIONS)
  const inputs: Record<string, Value> = {}
  for (const key of Object.keys(p.inputs)) {
    if (!def.inputs.some((i) => i.key === key)) {
      issues.push({ code: 'unknown-field', path: `runInputs.${key}`, message: `This workflow has no input called "${key}". Its inputs are: ${def.inputs.map((i) => i.key).join(', ') || 'none'}.` })
    }
  }
  for (const input of def.inputs) {
    const given = p.inputs[input.key]
    const label = input.label || input.key
    if (given === undefined || given === '') {
      if (input.default !== undefined) inputs[input.key] = structuredClone(input.default)
      else if (input.required !== false) issues.push({ code: 'missing-input', path: `runInputs.${input.key}`, message: `"${label}" is required.` })
      continue
    }
    const wrong = checkValue(given, { type: input.type, ...(input.options ? { options: input.options } : {}) })
    if (wrong) issues.push({ code: 'type-mismatch', path: `runInputs.${input.key}`, message: `"${label}" ${wrong}.` })
    else inputs[input.key] = structuredClone(given as Value)
  }
  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    run: settle({
      schema: WORKFLOW_SCHEMA,
      id: p.runId,
      workflowId: p.revision.workflowId,
      revision: p.revision.revision,
      definition: structuredClone(def),
      inputs,
      state: 'queued',
      paused: false,
      cancelled: false,
      createdAt: p.now,
      updatedAt: p.now,
      attempts: []
    })
  }
}

// Planning

/**
 * Jobs that can start now: never attempted, with every job they depend on succeeded on its latest attempt. Nothing
 * while the run is paused, cancelled or stopped by a failed or interrupted job.
 */
export function readyJobs(run: WorkflowRun): string[] {
  if (run.cancelled || run.paused) return []
  const order = executionOrder(run.definition)
  if (!order) return []
  const latest = new Map(order.map((id) => [id, latestAttempt(run, id)]))
  if ([...latest.values()].some((a) => a?.state === 'failed' || a?.state === 'interrupted')) return []
  const graph = dependencyGraph(run.definition)
  return order.filter((id) => !latest.get(id) && (graph.get(id) ?? []).every((d) => latest.get(d)?.state === 'succeeded'))
}

/** The run's state, from its attempts and flags. */
export function deriveRunState(run: WorkflowRun): RunState {
  if (run.cancelled) return 'cancelled'
  const latest = run.definition.jobs.map((j) => latestAttempt(run, j.id))
  if (latest.some((a) => a?.state === 'waiting-for-user')) return 'waiting-for-user'
  if (latest.some((a) => a?.state === 'queued' || a?.state === 'running')) return 'running'
  if (run.paused) return 'paused'
  if (latest.some((a) => a?.state === 'failed')) return 'failed'
  if (latest.some((a) => a?.state === 'interrupted')) return 'interrupted'
  if (latest.length > 0 && latest.every((a) => a?.state === 'succeeded')) return 'succeeded'
  return run.attempts.length ? 'running' : 'queued'
}

function settle(run: WorkflowRun): WorkflowRun {
  return { ...run, state: deriveRunState(run) }
}

const isFinished = (run: WorkflowRun): boolean => run.cancelled || run.state === 'succeeded'

// Results

/** What's wrong with a result against the declared output fields. Unknown fields are refused, not dropped. */
export function checkOutputs(specs: OutputSpec[], outputs: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const spec of specs) {
    const v = outputs[spec.key]
    if (v === undefined) {
      if (spec.required !== false) problems.push(`"${spec.key}" is missing`)
      continue
    }
    const wrong = checkValue(v, { type: spec.type, ...(spec.options ? { options: spec.options } : {}) })
    if (wrong) problems.push(`"${spec.key}" ${wrong}`)
  }
  for (const key of Object.keys(outputs)) {
    if (!specs.some((s) => s.key === key)) problems.push(`"${key}" isn't one of this job's outputs (${specs.map((s) => s.key).join(', ')})`)
  }
  return problems
}

const reject = (code: RejectCode, message: string): Transition => ({ ok: false, code, message })

/**
 * Finds the attempt a report is about and refuses reports that can't apply to it: an unknown attempt, one of
 * another job, a cancelled run, an attempt a retry replaced (stale) or one already settled (duplicate).
 */
function target(run: WorkflowRun, attemptIdValue: string, jobId?: string): { ok: true; attempt: JobAttempt } | { ok: false; t: Transition } {
  const attempt = run.attempts.find((a) => a.id === attemptIdValue)
  if (!attempt) return { ok: false, t: reject('unknown-attempt', `Run ${run.id} has no attempt ${attemptIdValue}.`) }
  if (jobId !== undefined && attempt.jobId !== jobId) {
    return { ok: false, t: reject('wrong-job', `Attempt ${attemptIdValue} belongs to job "${attempt.jobId}", not "${jobId}".`) }
  }
  if (run.cancelled) return { ok: false, t: reject('cancelled', `Run ${run.id} was cancelled, so nothing more is recorded for it.`) }
  if (latestAttempt(run, attempt.jobId)?.id !== attempt.id) {
    return { ok: false, t: reject('stale', `Attempt ${attempt.number} of "${attempt.jobId}" was replaced by a newer attempt, so its report is ignored.`) }
  }
  if (isSettled(attempt)) return { ok: false, t: reject('duplicate', `Attempt ${attempt.number} of "${attempt.jobId}" already ${attempt.state}.`) }
  return { ok: true, attempt }
}

function replaceAttempt(run: WorkflowRun, next: JobAttempt, now: number): WorkflowRun {
  return settle({ ...run, updatedAt: now, attempts: run.attempts.map((a) => (a.id === next.id ? next : a)) })
}

function newAttempt(run: WorkflowRun, jobId: string, now: number): JobAttempt {
  const number = run.attempts.filter((a) => a.jobId === jobId).reduce((n, a) => Math.max(n, a.number), 0) + 1
  return { id: attemptId(run.id, jobId, number), runId: run.id, jobId, number, state: 'queued', createdAt: now }
}

/** Applies one report to a run. Refused reports leave the run as it was and say why. */
export function applyRunEvent(run: WorkflowRun, event: RunEvent, now: number, catalog: ActionCatalog = BUILT_IN_ACTIONS): Transition {
  switch (event.type) {
    case 'enqueue': {
      if (!job(run, event.jobId)) return reject('unknown-job', `This workflow has no job "${event.jobId}".`)
      if (run.cancelled) return reject('cancelled', `Run ${run.id} was cancelled.`)
      if (!readyJobs(run).includes(event.jobId)) return reject('not-ready', `Job "${event.jobId}" can't start yet: it already has an attempt, or what it waits for hasn't succeeded.`)
      return { ok: true, run: settle({ ...run, updatedAt: now, attempts: [...run.attempts, newAttempt(run, event.jobId, now)] }) }
    }
    case 'retry': {
      const j = job(run, event.jobId)
      if (!j) return reject('unknown-job', `This workflow has no job "${event.jobId}".`)
      if (run.cancelled) return reject('cancelled', `Run ${run.id} was cancelled; start a new run instead.`)
      const latest = latestAttempt(run, event.jobId)
      if (!latest || (latest.state !== 'failed' && latest.state !== 'interrupted')) {
        return reject('bad-state', `Only a failed or interrupted job can be retried; "${event.jobId}" is ${latest?.state ?? 'not started'}.`)
      }
      const retriesSoFar = run.attempts.filter((a) => a.jobId === event.jobId).length - 1
      const budget = j.limits?.retries ?? 0
      if (event.by === 'auto' && retriesSoFar >= budget) return reject('retry-limit', `"${j.name}" has used its ${budget} automatic retr${budget === 1 ? 'y' : 'ies'}.`)
      return { ok: true, run: settle({ ...run, updatedAt: now, attempts: [...run.attempts, newAttempt(run, event.jobId, now)] }) }
    }
    case 'pause':
    case 'unpause': {
      if (isFinished(run)) return reject('finished', `Run ${run.id} is ${run.state}.`)
      const paused = event.type === 'pause'
      if (run.paused === paused) return { ok: true, run }
      return { ok: true, run: settle({ ...run, paused, updatedAt: now }) }
    }
    case 'cancel': {
      if (run.cancelled) return { ok: true, run }
      if (run.state === 'succeeded') return reject('finished', `Run ${run.id} already succeeded.`)
      const reason = event.reason ?? 'Run cancelled'
      const attempts = run.attempts.map((a): JobAttempt => (ACTIVE.includes(a.state) ? { ...a, state: 'cancelled', endedAt: now, reason } : a))
      const skipped = run.definition.jobs
        .filter((j) => !run.attempts.some((a) => a.jobId === j.id))
        .map((j): JobAttempt => ({ ...newAttempt(run, j.id, now), state: 'skipped', endedAt: now, reason: `Not reached: ${reason.toLowerCase()}` }))
      return { ok: true, run: settle({ ...run, cancelled: true, updatedAt: now, attempts: [...attempts, ...skipped] }) }
    }
  }

  const found = target(run, event.attemptId, 'jobId' in event ? event.jobId : undefined)
  if (!found.ok) return found.t
  const attempt = found.attempt

  switch (event.type) {
    case 'dispatching':
      if (attempt.state !== 'queued') return reject('bad-state', `Attempt ${attempt.id} is ${attempt.state}, not queued.`)
      if (attempt.dispatchedAt !== undefined) return reject('duplicate', `Attempt ${attempt.id} was already handed to its adapter; launching it again could run it twice.`)
      if (run.paused) return reject('not-ready', `Run ${run.id} is paused.`)
      return { ok: true, run: replaceAttempt(run, { ...attempt, dispatchedAt: now }, now) }
    case 'started':
      if (attempt.state !== 'queued') return reject('bad-state', `Attempt ${attempt.id} is ${attempt.state}, not queued.`)
      return {
        ok: true,
        run: replaceAttempt(run, { ...attempt, state: 'running', dispatchedAt: attempt.dispatchedAt ?? now, startedAt: now, ...(event.correlation ? { correlation: event.correlation } : {}) }, now)
      }
    case 'wait':
      if (attempt.state !== 'running') return reject('bad-state', `Attempt ${attempt.id} is ${attempt.state}, not running.`)
      return { ok: true, run: replaceAttempt(run, { ...attempt, state: 'waiting-for-user', reason: event.reason }, now) }
    case 'resume': {
      if (attempt.state !== 'waiting-for-user') return reject('bad-state', `Attempt ${attempt.id} is ${attempt.state}, not waiting.`)
      const { reason: _reason, ...rest } = attempt
      return { ok: true, run: replaceAttempt(run, { ...rest, state: 'running' }, now) }
    }
    case 'interrupt':
      return { ok: true, run: replaceAttempt(run, { ...attempt, state: 'interrupted', endedAt: now, reason: event.reason }, now) }
    case 'submit':
    case 'fail': {
      const j = job(run, attempt.jobId)!
      const action = findAction(catalog, j.action)
      if (!action) return reject('not-allowed', `Job "${j.id}" uses an action "${j.action}" this Patchbay doesn't have.`)
      if (event.by !== action.completedBy) {
        const who = { agent: 'the assigned agent', adapter: 'Patchbay', person: 'a person' }[action.completedBy]
        return reject('not-allowed', `Only ${who} can report the result of "${j.name}" (${action.label}).`)
      }
      if (attempt.state !== 'running' && attempt.state !== 'waiting-for-user') {
        return reject('bad-state', `Attempt ${attempt.id} is ${attempt.state}; it hasn't started.`)
      }
      if (event.type === 'fail') {
        return { ok: true, run: replaceAttempt(run, { ...attempt, state: 'failed', endedAt: now, error: event.error }, now) }
      }
      const problems = checkOutputs(jobOutputs(j, catalog), event.outputs)
      if (problems.length) return reject('bad-outputs', `The result for "${j.name}" doesn't match its outputs: ${problems.join('; ')}.`)
      const outputs = structuredClone(event.outputs)
      const gate = action.successWhen
      const passed = !gate || outputs[gate.output] === gate.equals
      const { reason: _reason, ...rest } = attempt
      const settled: JobAttempt = passed
        ? { ...rest, state: 'succeeded', endedAt: now, outputs }
        : { ...rest, state: 'failed', endedAt: now, outputs, error: `${gate!.output} was ${JSON.stringify(outputs[gate!.output])}, not ${JSON.stringify(gate!.equals)}` }
      return { ok: true, run: replaceAttempt(run, settled, now) }
    }
  }
}

// Recovery

/**
 * A run as found after Patchbay restarts. An attempt never handed to its adapter is still safe to launch. One that
 * was handed over but never reported started, or was running and isn't among those its adapter reports alive, is
 * interrupted: there's no evidence of how it ended, so it's never taken as success, and it is only run again when
 * someone retries it. A job waiting for a person's decision has no process to lose, so it keeps waiting.
 */
export function recoverRun(run: WorkflowRun, now: number, alive: ReadonlySet<string> = new Set(), catalog: ActionCatalog = BUILT_IN_ACTIONS): WorkflowRun {
  if (run.cancelled) return run
  let changed = false
  const byPerson = (a: JobAttempt): boolean => {
    const j = job(run, a.jobId)
    return !!j && findAction(catalog, j.action)?.completedBy === 'person'
  }
  const attempts = run.attempts.map((a): JobAttempt => {
    if (a.state === 'queued' && a.dispatchedAt === undefined) return a
    if (a.state === 'waiting-for-user' && byPerson(a)) return a
    if (a.state === 'queued') {
      changed = true
      return { ...a, state: 'interrupted', endedAt: now, reason: 'Patchbay stopped while starting this job, so it may or may not have started. Check, then retry it.' }
    }
    if ((a.state === 'running' || a.state === 'waiting-for-user') && !alive.has(a.id)) {
      changed = true
      return { ...a, state: 'interrupted', endedAt: now, reason: "Patchbay stopped before this job's result was recorded. Retry it to run it again." }
    }
    return a
  })
  return changed ? settle({ ...run, attempts, updatedAt: now }) : run
}

// Inputs for a job

export interface ResolvedValue { value: Value; from: Provenance[] }

function render(v: Value): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.join(' ')
  return v.path
}

/**
 * A job's parameter values for an attempt, from the run's inputs and the outputs of the latest succeeded attempts of
 * the jobs it reads, each with where it came from. A parameter whose source is empty is left out, so the action's
 * own default applies; one the action needs is listed as missing.
 */
export function resolveInputs(run: WorkflowRun, jobId: string, catalog: ActionCatalog = BUILT_IN_ACTIONS):
  { ok: true; values: Record<string, ResolvedValue> } | { ok: false; missing: string[] } {
  const j = job(run, jobId)
  if (!j) return { ok: false, missing: [`job ${jobId}`] }
  const action = findAction(catalog, j.action)
  const output = (ref: { job: string; output: string }): ResolvedValue | null => {
    const a = latestAttempt(run, ref.job)
    const v = a?.state === 'succeeded' ? a.outputs?.[ref.output] : undefined
    return v === undefined ? null : { value: v, from: [{ runId: run.id, jobId: ref.job, attemptId: a!.id }] }
  }
  const input = (key: string): ResolvedValue | null => (run.inputs[key] === undefined ? null : { value: run.inputs[key], from: [] })
  const resolve = (b: Binding): ResolvedValue | null => {
    switch (b.from) {
      case 'const': return { value: b.value, from: [] }
      case 'input': return input(b.input)
      case 'job': return output(b)
      case 'template': {
        const from: Provenance[] = []
        const text = b.parts.map((p) => {
          if (typeof p === 'string') return p
          const r = 'input' in p ? input(p.input) : output(p)
          if (!r) return ''
          from.push(...r.from)
          return render(r.value)
        }).join('')
        return { value: text, from }
      }
      case 'list': {
        const items = b.items.map(resolve)
        return { value: items.flatMap((r) => (r ? [render(r.value)] : [])), from: items.flatMap((r) => r?.from ?? []) }
      }
    }
  }
  const values: Record<string, ResolvedValue> = {}
  const missing: string[] = []
  for (const [key, b] of Object.entries(j.inputs)) {
    const r = resolve(b)
    if (r) values[key] = r
  }
  for (const p of action?.params ?? []) {
    if (values[p.key]) continue
    if (p.default !== undefined) values[p.key] = { value: p.default, from: [] }
    else if (p.required !== false) missing.push(p.key)
  }
  return missing.length ? { ok: false, missing } : { ok: true, values }
}
