/**
 * Workflows: saved, versioned processes with inputs, jobs and outputs. This file is the contract shared by the
 * workflow core, the main-process store and (later) the renderer. See docs/plans/workflows.md and workflows-impl.md.
 * Nothing here runs anything.
 */

export const WORKFLOW_SCHEMA = 1

export type ValueType = 'text' | 'number' | 'boolean' | 'enum' | 'text-list' | 'file' | 'workspace'
export const VALUE_TYPES: readonly ValueType[] = ['text', 'number', 'boolean', 'enum', 'text-list', 'file', 'workspace']

/** A file a job produced or reads. `sha256` pins the content, so a path can't silently point at something else. */
export interface FileRef { kind: 'file'; path: string; sha256?: string }
/** A folder agents and commands work in, with the git revision it was at when that was recorded. */
export interface WorkspaceRef { kind: 'workspace'; path: string; revision?: string | null }
export type Value = string | number | boolean | string[] | FileRef | WorkspaceRef

export interface WorkflowInput {
  key: string
  label: string
  type: ValueType
  /** The choices, for an enum. */
  options?: string[]
  /** Required unless false. */
  required?: boolean
  default?: Value
  description?: string
}

/** A result field a job declares. Required unless `required` is false. */
export interface OutputSpec {
  key: string
  label?: string
  type: ValueType
  options?: string[]
  required?: boolean
}

export interface OutputRef { job: string; output: string }
export type TemplatePart = string | { input: string } | OutputRef

/** Where a job parameter's value comes from. Always structured: never an expression or text to substitute into a shell. */
export type Binding =
  | { from: 'const'; value: Value }
  | { from: 'input'; input: string }
  | { from: 'job'; job: string; output: string }
  /** Text with labelled chips, such as a prompt. Resolves to text. */
  | { from: 'template'; parts: TemplatePart[] }
  /** A list of text, such as a command's arguments, one binding per item. */
  | { from: 'list'; items: Binding[] }

export interface JobLimits {
  timeoutMs?: number
  /** How many times the job can be retried by hand, 0 to 5. */
  retries?: number
}

export interface WorkflowJob {
  /** Stable key. Renaming a job changes `name`, never this, so bindings survive. */
  id: string
  name: string
  description?: string
  /** An action id from the catalog, such as `agent` or `command`. */
  action: string
  /** Parameter values, by the action's parameter key. */
  inputs: Record<string, Binding>
  /** Result fields the job declares, for actions that let the author choose them. */
  outputs?: OutputSpec[]
  /** Jobs this one waits for without taking anything from them. */
  after?: string[]
  limits?: JobLimits
}

export interface WorkflowOutput { key: string; label?: string; from: OutputRef }

export interface WorkflowDefinition {
  schema: typeof WORKFLOW_SCHEMA
  id: string
  name: string
  description?: string
  inputs: WorkflowInput[]
  /** In outline order. */
  jobs: WorkflowJob[]
  outputs?: WorkflowOutput[]
}

/** A saved draft. `version` goes up on every save, so an edit made against an older copy is refused. */
export interface DraftRecord {
  schema: typeof WORKFLOW_SCHEMA
  id: string
  version: number
  createdAt: number
  updatedAt: number
  definition: WorkflowDefinition
  /** Revision numbers published from this draft, in order. */
  published: number[]
}

/** A published snapshot. Never changed once written; runs copy its definition. */
export interface DefinitionRevision {
  schema: typeof WORKFLOW_SCHEMA
  workflowId: string
  revision: number
  publishedAt: number
  /** Names exactly this definition. */
  hash: string
  definition: WorkflowDefinition
}

// Runs

export type AttemptState = 'queued' | 'running' | 'waiting-for-user' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | 'skipped'
export type RunState = Exclude<AttemptState, 'skipped'> | 'paused'
export const SETTLED_ATTEMPT: readonly AttemptState[] = ['succeeded', 'failed', 'interrupted', 'cancelled', 'skipped']

export interface Provenance { runId: string; jobId: string; attemptId: string }

/** One execution of a job in a run. A retry appends a new attempt; the old one is kept. */
export interface JobAttempt {
  id: string
  runId: string
  jobId: string
  /** 1 for the first attempt at this job in the run. */
  number: number
  state: AttemptState
  createdAt: number
  /** Set just before the adapter launches anything, so a restart can tell "never launched" from "might have". */
  dispatchedAt?: number
  startedAt?: number
  endedAt?: number
  /** What the adapter launched for it. */
  correlation?: { launchId?: string; sessionId?: string; nodeId?: string }
  outputs?: Record<string, Value>
  error?: string
  /** Why it is waiting, interrupted or skipped, such as `usage-limit` or `human-review`. */
  reason?: string
}

export interface WorkflowRun {
  schema: typeof WORKFLOW_SCHEMA
  id: string
  workflowId: string
  revision: number
  /** The whole definition as published, so edits and library changes never alter a run. */
  definition: WorkflowDefinition
  /** The run's inputs, defaults applied. */
  inputs: Record<string, Value>
  state: RunState
  paused: boolean
  cancelled: boolean
  createdAt: number
  updatedAt: number
  attempts: JobAttempt[]
}

// Validation

export type IssueCode =
  | 'shape' | 'empty' | 'duplicate-key' | 'unknown-action' | 'action-unavailable' | 'missing-input' | 'unknown-parameter'
  | 'dangling-input' | 'dangling-job' | 'dangling-output' | 'type-mismatch' | 'bad-default' | 'bad-option' | 'cycle'
  | 'outputs-not-allowed' | 'bad-limit' | 'unknown-field'

export interface ValidationIssue {
  code: IssueCode
  message: string
  /** Where, such as `jobs.review.inputs.instructions`. */
  path: string
  jobId?: string
}

// Reading a definition from JSON. Strict about JSON types and unknown fields; semantic problems are left to validation.

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'

export class WorkflowShapeError extends Error {
  constructor(message: string, readonly path: string, readonly code: IssueCode = 'shape') { super(message) }
}

function fail(path: string, message: string, code: IssueCode = 'shape'): never {
  throw new WorkflowShapeError(`${path}: ${message}`, path, code)
}

function only(raw: Raw, path: string, fields: readonly string[]): void {
  for (const k of Object.keys(raw)) {
    if (!fields.includes(k)) fail(`${path}.${k}`, `"${k}" isn't a field this version of Patchbay knows, so the workflow can't be used as it was written.`, 'unknown-field')
  }
}

function text(raw: Raw, field: string, path: string, optional: true): string | undefined
function text(raw: Raw, field: string, path: string, optional?: false): string
function text(raw: Raw, field: string, path: string, optional = false): string | undefined {
  const v = raw[field]
  if (v === undefined && optional) return undefined
  if (!isText(v)) fail(`${path}.${field}`, `"${field}" must be text.`)
  return v
}

function texts(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || !v.every(isText)) fail(path, 'must be a list of text.')
  return [...v]
}

export function isValueType(v: unknown): v is ValueType {
  return VALUE_TYPES.includes(v as ValueType)
}

function valueType(raw: Raw, path: string): ValueType {
  const v = raw.type
  if (!isValueType(v)) fail(`${path}.type`, `"type" must be one of ${VALUE_TYPES.join(', ')}.`)
  return v
}

export function readValue(v: unknown, path: string): Value {
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(path, 'must be a finite number.')
    return v
  }
  if (Array.isArray(v)) return texts(v, path)
  if (isObject(v) && v.kind === 'file') {
    only(v, path, ['kind', 'path', 'sha256'])
    return { kind: 'file', path: text(v, 'path', path), ...(v.sha256 !== undefined ? { sha256: text(v, 'sha256', path) } : {}) }
  }
  if (isObject(v) && v.kind === 'workspace') {
    only(v, path, ['kind', 'path', 'revision'])
    const revision = v.revision
    if (revision !== undefined && revision !== null && !isText(revision)) fail(`${path}.revision`, '"revision" must be text or null.')
    return { kind: 'workspace', path: text(v, 'path', path), ...(revision !== undefined ? { revision } : {}) }
  }
  fail(path, 'must be text, a number, true/false, a list of text, a file or a workspace.')
}

function readOutputRef(raw: unknown, path: string): OutputRef {
  if (!isObject(raw)) fail(path, 'must name a job and one of its outputs.')
  only(raw, path, ['job', 'output'])
  return { job: text(raw, 'job', path), output: text(raw, 'output', path) }
}

function readBinding(raw: unknown, path: string, depth = 0): Binding {
  if (!isObject(raw)) fail(path, 'must be a binding: a constant, a workflow input or a job output.')
  switch (raw.from) {
    case 'const':
      only(raw, path, ['from', 'value'])
      return { from: 'const', value: readValue(raw.value, `${path}.value`) }
    case 'input':
      only(raw, path, ['from', 'input'])
      return { from: 'input', input: text(raw, 'input', path) }
    case 'job':
      only(raw, path, ['from', 'job', 'output'])
      return { from: 'job', job: text(raw, 'job', path), output: text(raw, 'output', path) }
    case 'template': {
      only(raw, path, ['from', 'parts'])
      if (!Array.isArray(raw.parts)) fail(`${path}.parts`, '"parts" must be a list.')
      const parts = raw.parts.map((p, i): TemplatePart => {
        const where = `${path}.parts.${i}`
        if (isText(p)) return p
        if (isObject(p) && 'input' in p) {
          only(p, where, ['input'])
          return { input: text(p, 'input', where) }
        }
        return readOutputRef(p, where)
      })
      return { from: 'template', parts }
    }
    case 'list': {
      only(raw, path, ['from', 'items'])
      if (depth > 0) fail(path, 'a list can\'t hold another list.')
      if (!Array.isArray(raw.items)) fail(`${path}.items`, '"items" must be a list.')
      return { from: 'list', items: raw.items.map((b, i) => readBinding(b, `${path}.items.${i}`, depth + 1)) }
    }
    default:
      fail(`${path}.from`, '"from" must be const, input, job, template or list.')
  }
}

function readInput(raw: unknown, path: string): WorkflowInput {
  if (!isObject(raw)) fail(path, 'must be an object.')
  only(raw, path, ['key', 'label', 'type', 'options', 'required', 'default', 'description'])
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail(`${path}.required`, '"required" must be true or false.')
  return {
    key: text(raw, 'key', path),
    label: text(raw, 'label', path),
    type: valueType(raw, path),
    ...(raw.options !== undefined ? { options: texts(raw.options, `${path}.options`) } : {}),
    ...(raw.required !== undefined ? { required: raw.required as boolean } : {}),
    ...(raw.default !== undefined ? { default: readValue(raw.default, `${path}.default`) } : {}),
    ...(raw.description !== undefined ? { description: text(raw, 'description', path) } : {})
  }
}

export function readOutputSpec(raw: unknown, path: string): OutputSpec {
  if (!isObject(raw)) fail(path, 'must be an object.')
  only(raw, path, ['key', 'label', 'type', 'options', 'required'])
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail(`${path}.required`, '"required" must be true or false.')
  return {
    key: text(raw, 'key', path),
    ...(raw.label !== undefined ? { label: text(raw, 'label', path) } : {}),
    type: valueType(raw, path),
    ...(raw.options !== undefined ? { options: texts(raw.options, `${path}.options`) } : {}),
    ...(raw.required !== undefined ? { required: raw.required as boolean } : {})
  }
}

function readLimits(raw: unknown, path: string): JobLimits {
  if (!isObject(raw)) fail(path, 'must be an object.')
  only(raw, path, ['timeoutMs', 'retries'])
  const out: JobLimits = {}
  for (const k of ['timeoutMs', 'retries'] as const) {
    const v = raw[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${k}`, `"${k}" must be a number.`)
    out[k] = v
  }
  return out
}

function readJob(raw: unknown, path: string): WorkflowJob {
  if (!isObject(raw)) fail(path, 'must be an object.')
  only(raw, path, ['id', 'name', 'description', 'action', 'inputs', 'outputs', 'after', 'limits'])
  const id = text(raw, 'id', path)
  const where = `jobs.${id || path}`
  const inputs = raw.inputs ?? {}
  if (!isObject(inputs)) fail(`${where}.inputs`, '"inputs" must be an object of parameter bindings.')
  if (raw.outputs !== undefined && !Array.isArray(raw.outputs)) fail(`${where}.outputs`, '"outputs" must be a list.')
  return {
    id,
    name: text(raw, 'name', where),
    ...(raw.description !== undefined ? { description: text(raw, 'description', where) } : {}),
    action: text(raw, 'action', where),
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, b]) => [k, readBinding(b, `${where}.inputs.${k}`)])),
    ...(raw.outputs !== undefined ? { outputs: (raw.outputs as unknown[]).map((o, i) => readOutputSpec(o, `${where}.outputs.${i}`)) } : {}),
    ...(raw.after !== undefined ? { after: texts(raw.after, `${where}.after`) } : {}),
    ...(raw.limits !== undefined ? { limits: readLimits(raw.limits, `${where}.limits`) } : {})
  }
}

/**
 * Builds a definition from parsed JSON, field by field. Throws WorkflowShapeError naming the field when something
 * can't be represented, including fields this version doesn't know and newer schemas. A definition that reads can
 * still have validation issues; those don't stop it being saved.
 */
export function readDefinition(raw: unknown): WorkflowDefinition {
  if (!isObject(raw)) fail('workflow', 'must be an object.')
  if (typeof raw.schema === 'number' && raw.schema > WORKFLOW_SCHEMA) {
    fail('schema', `This workflow was saved by a newer Patchbay (schema ${raw.schema}); this one reads schema ${WORKFLOW_SCHEMA}.`, 'unknown-field')
  }
  if (raw.schema !== WORKFLOW_SCHEMA) fail('schema', `"schema" must be ${WORKFLOW_SCHEMA}.`)
  only(raw, 'workflow', ['schema', 'id', 'name', 'description', 'inputs', 'jobs', 'outputs'])
  if (!Array.isArray(raw.inputs)) fail('inputs', '"inputs" must be a list.')
  if (!Array.isArray(raw.jobs)) fail('jobs', '"jobs" must be a list.')
  if (raw.outputs !== undefined && !Array.isArray(raw.outputs)) fail('outputs', '"outputs" must be a list.')
  return {
    schema: WORKFLOW_SCHEMA,
    id: text(raw, 'id', 'workflow'),
    name: text(raw, 'name', 'workflow'),
    ...(raw.description !== undefined ? { description: text(raw, 'description', 'workflow') } : {}),
    inputs: raw.inputs.map((i, n) => readInput(i, `inputs.${n}`)),
    jobs: raw.jobs.map((j, n) => readJob(j, `jobs.${n}`)),
    ...(raw.outputs !== undefined
      ? {
          outputs: (raw.outputs as unknown[]).map((o, n): WorkflowOutput => {
            const path = `outputs.${n}`
            if (!isObject(o)) fail(path, 'must be an object.')
            only(o, path, ['key', 'label', 'from'])
            return { key: text(o, 'key', path), ...(o.label !== undefined ? { label: text(o, 'label', path) } : {}), from: readOutputRef(o.from, `${path}.from`) }
          })
        }
      : {})
  }
}

/** Every job a binding reads an output from. */
export function bindingJobs(b: Binding): string[] {
  switch (b.from) {
    case 'job': return [b.job]
    case 'template': return b.parts.flatMap((p) => (typeof p === 'object' && 'job' in p ? [p.job] : []))
    case 'list': return b.items.flatMap(bindingJobs)
    default: return []
  }
}

/** The jobs a job depends on: those it reads outputs from and those it waits for. No duplicates. */
export function jobDependencies(job: WorkflowJob): string[] {
  return [...new Set([...Object.values(job.inputs).flatMap(bindingJobs), ...(job.after ?? [])])]
}
