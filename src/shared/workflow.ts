import type { AgentKind } from './model'
import type { TaskRevision } from './task'
import { folderIn, isAbsoluteFolder, isInside } from './recipe'

/**
 * A workflow: a process with ordered steps that pass explicit results along. A recipe sets up a workspace; a workflow
 * runs a process in one. Both live in the same library folders and follow the same hash rule. See
 * docs/plans/workflows.md and workflows-impl.md. Nothing here runs anything.
 */

export const WORKFLOW_SCHEMA = 1
export const MAX_STEPS = 30
const MAX_PROMPT_CHARS = 28000
const MAX_TIMEOUT_MIN = 24 * 60

export type InputType = 'text' | 'number' | 'boolean' | 'enum'
export type InputValue = string | number | boolean

export interface InputSpec {
  key: string
  label: string
  type: InputType
  /** The choices, for an enum. */
  options?: string[]
  default?: InputValue
  /** Required unless false. */
  required?: boolean
  description?: string
}

export interface OutputSpec {
  key: string
  label?: string
  type: 'text' | 'file'
  /** Required unless false. */
  required?: boolean
}

/** What a review step shows: a workflow input, or an earlier step's output. */
export type Binding = { input: string } | { step: string; output: string }

interface StepBase {
  /** Stable key. Renaming a step changes its title, never this, so references survive. */
  key: string
  title: string
}

/**
 * A fresh agent session works on the prompt and submits its result with `patchbay job-submit`. Becoming idle is never
 * a result. The prompt can use {{in:KEY}} and {{out:STEP.OUTPUT}}.
 */
export interface AgentStep extends StepBase {
  kind: 'agent'
  agent: AgentKind
  prompt: string
  outputs: OutputSpec[]
  timeoutMin?: number
}

/**
 * A program and its arguments, run with no shell between, in a run node. Succeeds on exit code 0. Arguments can use
 * {{in:KEY}} and {{out:STEP.OUTPUT}}; the program can't.
 */
export interface CommandStep extends StepBase {
  kind: 'command'
  run: string[]
  /** Relative to the run's folder, and inside it. */
  folder?: string
  timeoutMin?: number
  /** Also counts as a required check on the run's deliverable task. */
  taskCheck?: boolean
}

/** Waits for a person to approve what it shows, or to request changes from the agent that made it. */
export interface ReviewStep extends StepBase {
  kind: 'review'
  question: string
  show: Binding[]
}

export type Step = AgentStep | CommandStep | ReviewStep
export type StepKind = Step['kind']

export interface Workflow {
  schema: typeof WORKFLOW_SCHEMA
  name: string
  description?: string
  /** Whether a run gets its own new worktree. Default true. */
  worktree?: boolean
  inputs: InputSpec[]
  steps: Step[]
  /** A task made for each run, accepted by a person in the review inbox. */
  deliverable?: { criteria: string[] }
}

/** Outputs every step of a kind has, in addition to an agent step's declared ones. */
export const FIXED_OUTPUTS: Record<StepKind, OutputSpec[]> = {
  agent: [],
  command: [
    { key: 'exitCode', label: 'Exit code', type: 'text' },
    { key: 'log', label: 'Log', type: 'file', required: false }
  ],
  review: [{ key: 'note', label: 'Note', type: 'text', required: false }]
}

export function stepOutputs(step: Step): OutputSpec[] {
  return step.kind === 'agent' ? step.outputs : FIXED_OUTPUTS[step.kind]
}

// Runs

export type OutputValue = { type: 'text'; text: string } | { type: 'file'; path: string; sha256: string; source: string }

export type AttemptState = 'launching' | 'running' | 'waiting-for-you' | 'succeeded' | 'failed' | 'interrupted' | 'superseded'
export const ACTIVE_STATES: readonly AttemptState[] = ['launching', 'running', 'waiting-for-you']

/** One go at a step. A retry is a new attempt on a new node; requested changes are a new attempt on the same node. */
export interface StepAttempt {
  /** `<runId>:<step>:<n>`. */
  id: string
  step: string
  /** 1 for the first attempt at the step. */
  n: number
  /** The node it runs in. Allocated before launching, so a restart can tell whether it was made. Null for reviews. */
  nodeId: string | null
  state: AttemptState
  outputs?: Record<string, OutputValue>
  exitCode?: number
  /** The run folder's identity when the result was submitted. */
  revision?: TaskRevision
  /** Why it is waiting, failed, interrupted or superseded. */
  why?: string
  /** A person recorded the result (approved, or marked done). */
  decidedBy?: 'person'
  /** Became idle without submitting a result. */
  idle?: boolean
  /** The idle agent was reminded to submit, once. */
  reminded?: boolean
  /** How it came about, when not the first time through. */
  via?: 'retry' | 'changes'
  startedAt: number
  endedAt?: number
}

export type RunState = 'running' | 'waiting-for-you' | 'succeeded' | 'failed' | 'stopped' | 'needs-attention'

export interface WorkflowRun {
  schema: typeof WORKFLOW_SCHEMA
  id: string
  projectId: string
  /** The library entry it was started from, such as `personal:Feature`. */
  ref: string
  /** The content hash of the definition as started. */
  hash: string
  /** The whole definition as started, so editing the file never changes a run. */
  definition: Workflow
  inputs: Record<string, InputValue>
  /** The folder the steps run in: the run's worktree, or the folder it was started in. */
  cwd: string
  worktree: { path: string; branch: string } | null
  /** The canvas group the run's nodes go in. */
  groupId: string | null
  taskId?: string
  state: RunState
  stopped?: boolean
  attempts: StepAttempt[]
  startedAt: number
  endedAt?: number
}

// Reading

export interface WorkflowIssue {
  message: string
  /** Where, such as `steps.plan.prompt`. */
  path: string
  step?: string
}

export class WorkflowError extends Error {
  constructor(message: string, readonly issues: WorkflowIssue[] = [{ message, path: '' }]) { super(message) }
}

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
export const STEP_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
/** {{in:KEY}} and {{out:STEP.OUTPUT}}, with spaces allowed inside the braces. */
const REF = /\{\{\s*(in|out):([^}\s]*)\s*\}\}/g

function fail(path: string, message: string): never {
  throw new WorkflowError(message, [{ path, message }])
}

function only(raw: Raw, path: string, where: string, fields: readonly string[]): void {
  for (const k of Object.keys(raw)) {
    if (!fields.includes(k)) fail(path ? `${path}.${k}` : k, `${where}: "${k}" isn't a field this version of Patchbay knows, so the workflow can't be used as written.`)
  }
}

function text(raw: Raw, field: string, path: string, where: string, max = 2000): string | undefined {
  const v = raw[field]
  if (v === undefined) return undefined
  if (!isText(v)) fail(`${path}.${field}`, `${where}: "${field}" must be text.`)
  if (v.length > max) fail(`${path}.${field}`, `${where}: "${field}" is longer than ${max} characters.`)
  return v
}

function flag(raw: Raw, field: string, path: string, where: string): boolean | undefined {
  const v = raw[field]
  if (v !== undefined && typeof v !== 'boolean') fail(`${path}.${field}`, `${where}: "${field}" must be true or false.`)
  return v as boolean | undefined
}

function texts(v: unknown, path: string, message: string): string[] {
  if (!Array.isArray(v) || !v.every(isText)) fail(path, message)
  return [...v]
}

function inputOf(raw: unknown, i: number): InputSpec {
  const path = `inputs.${i}`
  if (!isObject(raw)) fail(path, `Input ${i + 1} isn't an object.`)
  const where = `Input ${isText(raw.key) ? `"${raw.key}"` : i + 1}`
  only(raw, path, where, ['key', 'label', 'type', 'options', 'default', 'required', 'description'])
  const type = raw.type ?? 'text'
  if (!['text', 'number', 'boolean', 'enum'].includes(type as string)) fail(`${path}.type`, `${where}: "type" must be text, number, boolean or enum.`)
  const key = text(raw, 'key', path, where, 40) ?? ''
  const input: InputSpec = { key, label: text(raw, 'label', path, where, 200) ?? key, type: type as InputType }
  if (raw.options !== undefined) input.options = texts(raw.options, `${path}.options`, `${where}: "options" must be a list of text.`)
  if (raw.default !== undefined) {
    if (!['string', 'number', 'boolean'].includes(typeof raw.default)) fail(`${path}.default`, `${where}: "default" must be text, a number or true/false.`)
    input.default = raw.default as InputValue
  }
  const required = flag(raw, 'required', path, where)
  if (required !== undefined) input.required = required
  const description = text(raw, 'description', path, where)
  if (description !== undefined) input.description = description
  return input
}

function outputOf(raw: unknown, path: string, where: string): OutputSpec {
  if (!isObject(raw)) fail(path, `${where}: each output must be an object.`)
  only(raw, path, where, ['key', 'label', 'type', 'required'])
  const type = raw.type ?? 'text'
  if (type !== 'text' && type !== 'file') fail(`${path}.type`, `${where}: an output's "type" must be text or file.`)
  const out: OutputSpec = { key: text(raw, 'key', path, where, 40) ?? '', type }
  const label = text(raw, 'label', path, where, 200)
  if (label !== undefined) out.label = label
  const required = flag(raw, 'required', path, where)
  if (required !== undefined) out.required = required
  return out
}

function timeoutOf(raw: Raw, path: string, where: string): number | undefined {
  const v = raw.timeoutMin
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TIMEOUT_MIN) fail(`${path}.timeoutMin`, `${where}: "timeoutMin" must be a whole number of minutes from 1 to ${MAX_TIMEOUT_MIN}.`)
  return v
}

function stepOf(raw: unknown, i: number): Step {
  const path0 = `steps.${i}`
  if (!isObject(raw)) fail(path0, `Step ${i + 1} isn't an object.`)
  const key = raw.key
  if (!isText(key) || !STEP_KEY.test(key)) fail(`${path0}.key`, `Step ${i + 1}: "key" must start with a letter and use only letters, digits, - and _ (up to 40).`)
  const path = `steps.${key}`
  const where = `Step "${key}"`
  const title = text(raw, 'title', path, where, 200) ?? key
  switch (raw.kind) {
    case 'agent': {
      only(raw, path, where, ['kind', 'key', 'title', 'agent', 'prompt', 'outputs', 'timeoutMin'])
      const agent = raw.agent ?? 'claude'
      if (agent !== 'claude' && agent !== 'codex') fail(`${path}.agent`, `${where}: "agent" must be claude or codex.`)
      const outputs = raw.outputs ?? []
      if (!Array.isArray(outputs)) fail(`${path}.outputs`, `${where}: "outputs" must be a list.`)
      const step: AgentStep = {
        kind: 'agent', key, title, agent,
        prompt: text(raw, 'prompt', path, where, MAX_PROMPT_CHARS) ?? '',
        outputs: outputs.map((o, n) => outputOf(o, `${path}.outputs.${n}`, where))
      }
      const timeoutMin = timeoutOf(raw, path, where)
      if (timeoutMin !== undefined) step.timeoutMin = timeoutMin
      return step
    }
    case 'command': {
      only(raw, path, where, ['kind', 'key', 'title', 'run', 'folder', 'timeoutMin', 'taskCheck'])
      const step: CommandStep = {
        kind: 'command', key, title,
        run: texts(raw.run ?? [], `${path}.run`, `${where}: "run" must be the program and its arguments, as a list, like ["npm", "test"].`)
      }
      const folder = text(raw, 'folder', path, where, 1000)
      if (folder !== undefined) step.folder = folder
      const timeoutMin = timeoutOf(raw, path, where)
      if (timeoutMin !== undefined) step.timeoutMin = timeoutMin
      const taskCheck = flag(raw, 'taskCheck', path, where)
      if (taskCheck !== undefined) step.taskCheck = taskCheck
      return step
    }
    case 'review': {
      only(raw, path, where, ['kind', 'key', 'title', 'question', 'show'])
      const show = raw.show ?? []
      if (!Array.isArray(show)) fail(`${path}.show`, `${where}: "show" must be a list.`)
      return {
        kind: 'review', key, title,
        question: text(raw, 'question', path, where) ?? '',
        show: show.map((b, n): Binding => {
          const at = `${path}.show.${n}`
          if (isObject(b) && isText(b.input) && Object.keys(b).length === 1) return { input: b.input }
          if (isObject(b) && isText(b.step) && isText(b.output) && Object.keys(b).length === 2) return { step: b.step, output: b.output }
          return fail(at, `${where}: each thing to show must be {"input": KEY} or {"step": KEY, "output": KEY}.`)
        })
      }
    }
    default:
      return fail(`${path}.kind`, `${where}: "kind" must be agent, command or review, not ${JSON.stringify(raw.kind)}.`)
  }
}

/**
 * The workflow's shape from parsed JSON, field by field. Throws a WorkflowError naming the field when something can't
 * be represented, including fields this version doesn't know: an executable field must never be dropped and the
 * rest run with a changed meaning. A workflow that reads can still have issues (see workflowIssues).
 */
export function readWorkflowShape(raw: unknown): Workflow {
  if (!isObject(raw)) fail('', 'A workflow must be a JSON object.')
  if (raw.schema !== WORKFLOW_SCHEMA) {
    const newer = typeof raw.schema === 'number' && raw.schema > WORKFLOW_SCHEMA
    fail('schema', newer ? `This workflow is from a newer Patchbay (schema ${raw.schema}); this one reads schema ${WORKFLOW_SCHEMA}.` : `Unknown workflow schema ${JSON.stringify(raw.schema)}. This version of Patchbay reads schema ${WORKFLOW_SCHEMA}.`)
  }
  only(raw, '', 'The workflow', ['schema', 'name', 'description', 'worktree', 'inputs', 'steps', 'deliverable'])
  const inputs = raw.inputs ?? []
  if (!Array.isArray(inputs)) fail('inputs', '"inputs" must be a list.')
  if (!Array.isArray(raw.steps)) fail('steps', '"steps" must be a list.')
  const wf: Workflow = { schema: WORKFLOW_SCHEMA, name: (text(raw, 'name', '', 'The workflow', 120) ?? '').trim(), inputs: inputs.map(inputOf), steps: raw.steps.map(stepOf) }
  const description = text(raw, 'description', '', 'The workflow')
  if (description) wf.description = description
  const worktree = flag(raw, 'worktree', '', 'The workflow')
  if (worktree !== undefined) wf.worktree = worktree
  if (raw.deliverable !== undefined) {
    if (!isObject(raw.deliverable)) fail('deliverable', '"deliverable" must be an object.')
    only(raw.deliverable, 'deliverable', 'The deliverable', ['criteria'])
    wf.deliverable = { criteria: texts(raw.deliverable.criteria ?? [], 'deliverable.criteria', '"deliverable.criteria" must be a list of text.') }
  }
  return wf
}

// Checking

/** References in a prompt or argument: {{in:KEY}} and {{out:STEP.OUTPUT}}. `bad` is one that isn't well formed. */
export function templateRefs(t: string): Array<{ whole: string } & ({ input: string } | { step: string; output: string } | { bad: true })> {
  return [...t.matchAll(REF)].map((m) => {
    const [whole, kind, body] = m
    if (kind === 'in') return STEP_KEY.test(body) ? { whole, input: body } : { whole, bad: true as const }
    const dot = body.indexOf('.')
    const step = body.slice(0, dot)
    const output = body.slice(dot + 1)
    return dot > 0 && STEP_KEY.test(step) && STEP_KEY.test(output) ? { whole, step, output } : { whole, bad: true as const }
  })
}

/** Programs that read an argument as a command line of their own, so a value put into it could run anything. */
const SHELLS = /^(?:.*[\\/])?(?:cmd|powershell|pwsh|bash|sh|zsh|dash|fish|wsl|git-bash)(?:\.exe)?$/i
/** Flags after which an interpreter runs its next argument as code, such as node -e or python -c. */
const EVAL_FLAG = /^(?:-c|\/c|\/k|-e|--eval|-p|--print|-command|-encodedcommand)$/i
/** Characters some shell acts on; a value with one is refused before it reaches a command (see recipe.ts). */
export const SHELL_ACTS_ON = /["'`$&|<>;()%^!\r\n]/

const quote = (s: string): string => `"${s}"`

/**
 * Everything wrong with a workflow, each with where and what to do. Empty means it can be started. Never throws.
 * Steps only use what earlier steps produced: they run one after another.
 */
export function workflowIssues(wf: Workflow): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const add = (path: string, message: string, step?: string): void => { issues.push({ path, message, ...(step ? { step } : {}) }) }
  if (!wf.name) add('name', 'Give the workflow a name.')
  if (!wf.steps.length) add('steps', 'The workflow has no steps yet. Add a step.')
  if (wf.steps.length > MAX_STEPS) add('steps', `A workflow can have at most ${MAX_STEPS} steps; this one has ${wf.steps.length}.`)

  const inputs = new Map<string, InputSpec>()
  wf.inputs.forEach((input, i) => {
    const path = `inputs.${input.key || i}`
    const what = `Input ${quote(input.label || input.key)}`
    if (!STEP_KEY.test(input.key)) add(path, `Input key ${quote(input.key)} must start with a letter and use only letters, digits, - and _ (up to 40).`)
    else if (inputs.has(input.key)) add(path, `Two inputs are called ${quote(input.key)}.`)
    else inputs.set(input.key, input)
    if (input.type === 'enum') {
      if (!input.options?.length) add(`${path}.options`, `${what} is a choice but has no options.`)
      else if (new Set(input.options).size !== input.options.length) add(`${path}.options`, `${what} lists the same option twice.`)
    } else if (input.options !== undefined) add(`${path}.options`, `${what} has options, but only a choice (enum) can.`)
    if (input.default !== undefined) {
      const wrong = checkInputValue(input, input.default)
      if (wrong) add(`${path}.default`, `The default for ${what.toLowerCase()} ${wrong}.`)
    }
  })

  const steps = new Map<string, { step: Step; index: number }>()
  wf.steps.forEach((step, index) => {
    if (steps.has(step.key)) add(`steps.${step.key}`, `Two steps have the key ${quote(step.key)}.`, step.key)
    else steps.set(step.key, { step, index })
  })

  /** Checks a reference from step `index` to an input or an earlier step's output. */
  const checkRef = (ref: Binding, at: string, reader: Step, index: number): void => {
    const who = `Step ${quote(reader.title)}`
    if ('input' in ref) {
      if (!inputs.has(ref.input)) add(at, `${who} uses an input ${quote(ref.input)} that isn't in this workflow. Inputs: ${[...inputs.keys()].join(', ') || 'none'}.`, reader.key)
      return
    }
    const source = steps.get(ref.step)
    if (!source) {
      add(at, `${who} uses ${quote(`${ref.step}.${ref.output}`)}, but there's no step ${quote(ref.step)}.`, reader.key)
      return
    }
    if (source.index >= index) {
      const which = source.index === index ? 'its own output' : `${quote(source.step.title)}, which runs after it`
      add(at, `${who} uses ${which}. A step can only use outputs of the steps before it.`, reader.key)
      return
    }
    const outs = stepOutputs(source.step)
    if (!outs.some((o) => o.key === ref.output)) {
      add(at, `${who} uses ${quote(ref.output)} from ${quote(source.step.title)}, which has no such output. Its outputs: ${outs.map((o) => o.key).join(', ') || 'none'}.`, reader.key)
    }
  }
  const checkText = (t: string, at: string, reader: Step, index: number): number => {
    const refs = templateRefs(t)
    for (const r of refs) {
      if ('bad' in r) add(at, `Step ${quote(reader.title)}: ${r.whole} isn't a reference. Use {{in:KEY}} or {{out:STEP.OUTPUT}}.`, reader.key)
      else checkRef(r, at, reader, index)
    }
    return refs.length
  }

  wf.steps.forEach((step, index) => {
    const path = `steps.${step.key}`
    const who = `Step ${quote(step.title)}`
    if (!step.title.trim()) add(`${path}.title`, `Step ${quote(step.key)} needs a title.`, step.key)
    switch (step.kind) {
      case 'agent': {
        if (!step.prompt.trim()) add(`${path}.prompt`, `${who} needs a prompt.`, step.key)
        checkText(step.prompt, `${path}.prompt`, step, index)
        const keys = new Set<string>()
        step.outputs.forEach((o, n) => {
          const at = `${path}.outputs.${o.key || n}`
          if (!STEP_KEY.test(o.key)) add(at, `Output key ${quote(o.key)} of ${who.toLowerCase()} must start with a letter and use only letters, digits, - and _.`, step.key)
          else if (keys.has(o.key)) add(at, `${who} has two outputs called ${quote(o.key)}.`, step.key)
          keys.add(o.key)
        })
        break
      }
      case 'command': {
        const [program, ...args] = step.run
        if (!program?.trim()) add(`${path}.run`, `${who} needs a program to run, like ["npm", "test"].`, step.key)
        else if (templateRefs(program).length) add(`${path}.run.0`, `${who}: the program can't come from an input or an output. Name it in the workflow.`, step.key)
        let bound = 0
        args.forEach((a, n) => {
          const refs = checkText(a, `${path}.run.${n + 1}`, step, index)
          bound += refs
          if (refs && n > 0 && EVAL_FLAG.test(args[n - 1])) {
            add(`${path}.run.${n + 1}`, `${who} puts a value right after ${quote(args[n - 1])}, where it would run as code. Pass it as data instead.`, step.key)
          }
        })
        if (program && bound && SHELLS.test(program.trim())) {
          add(`${path}.run`, `${who} puts values into ${quote(program)}, which would read them as commands. Run the tool itself instead, like ["npm", "test", "--", "{{in:filter}}"].`, step.key)
        }
        if (step.folder !== undefined) {
          const root = 'C:\\run'
          if (isAbsoluteFolder(step.folder) || !isInside(root, folderIn(root, step.folder))) {
            add(`${path}.folder`, `${who}: the folder ${quote(step.folder)} must be inside the run's folder, like "packages/app".`, step.key)
          }
        }
        if (step.taskCheck && !wf.deliverable) add(`${path}.taskCheck`, `${who} is a check on the deliverable task, but the workflow has no deliverable.`, step.key)
        if (step.taskCheck) {
          // The task's check is declared when the run starts and runs through cmd: only inputs are known then, and
          // nothing in it may be something cmd acts on.
          if (step.run.some((a) => templateRefs(a).some((r) => 'step' in r))) add(`${path}.taskCheck`, `${who} is a check on the deliverable task, so it can only use inputs, not other steps' outputs.`, step.key)
          const bad = step.run.find((a) => SHELL_ACTS_ON.test(a.replace(/\{\{[^}]*\}\}/g, '')))
          if (bad !== undefined) add(`${path}.taskCheck`, `${who} is a check on the deliverable task, which runs it through cmd, so ${quote(bad)} can't contain characters cmd acts on.`, step.key)
        }
        break
      }
      case 'review':
        if (!step.question.trim()) add(`${path}.question`, `${who} needs a question for the person.`, step.key)
        if (!step.show.length) add(`${path}.show`, `${who} doesn't show anything. Choose an input or an earlier step's output.`, step.key)
        step.show.forEach((b, n) => checkRef(b, `${path}.show.${n}`, step, index))
        break
    }
  })
  wf.deliverable?.criteria.forEach((c, i) => { if (!c.trim()) add(`deliverable.criteria.${i}`, 'A deliverable criterion is empty.') })
  return issues
}

/** Reads a workflow from parsed JSON and checks it. Throws a WorkflowError with every issue. */
export function readWorkflow(raw: unknown): Workflow {
  const wf = readWorkflowShape(raw)
  const issues = workflowIssues(wf)
  if (issues.length) throw new WorkflowError(issues.length === 1 ? issues[0].message : `${issues[0].message} (and ${issues.length - 1} more)`, issues)
  return wf
}

/** What's wrong with a value for an input, or null. */
export function checkInputValue(input: InputSpec, v: unknown): string | null {
  switch (input.type) {
    case 'text': return typeof v === 'string' ? null : 'must be text'
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number'
    case 'boolean': return typeof v === 'boolean' ? null : 'must be true or false'
    case 'enum':
      return typeof v === 'string' && (!input.options || input.options.includes(v)) ? null : `must be one of ${(input.options ?? []).join(', ')}`
  }
}

/** The file name a workflow is saved as. */
export function workflowFileName(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workflow'}.json`
}
