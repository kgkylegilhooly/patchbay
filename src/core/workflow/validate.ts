import {
  readDefinition, WorkflowShapeError, type Binding, type IssueCode, type OutputSpec, type TemplatePart, type ValidationIssue,
  type WorkflowDefinition, type WorkflowJob
} from '../../shared/workflow'
import { assignable, BUILT_IN_ACTIONS, checkValue, describeType, findAction, typeOfValue, type ActionCatalog, type ParamSpec, type TypeSpec } from './catalog'
import { findCycles } from './plan'

export const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
export const MAX_RETRIES = 5
const MAX_JOBS = 50

/** A binding's source as validation sees it: its type, and whether it can be absent at run time. */
interface Source { type: TypeSpec; optional: boolean; label: string }

/** A job's outputs: the action's fixed ones, then those the job declares. */
export function jobOutputs(job: WorkflowJob, catalog: ActionCatalog = BUILT_IN_ACTIONS): OutputSpec[] {
  const action = findAction(catalog, job.action)
  return [...(action?.outputs ?? []), ...(job.outputs ?? [])]
}

const named = (job: WorkflowJob): string => `"${job.name || job.id}"`
const typeOf = (o: { type: TypeSpec['type']; options?: string[] }): TypeSpec => ({ type: o.type, ...(o.options ? { options: o.options } : {}) })

/**
 * Everything wrong with a definition, each with a path and a message a person or agent can act on. Empty means it
 * can be published and run. Never throws.
 */
export function validateDefinition(def: WorkflowDefinition, catalog: ActionCatalog = BUILT_IN_ACTIONS): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (code: IssueCode, path: string, message: string, jobId?: string): void => {
    issues.push({ code, path, message, ...(jobId ? { jobId } : {}) })
  }

  if (!def.name.trim()) add('empty', 'name', 'Give the workflow a name.')
  if (!def.jobs.length) add('empty', 'jobs', 'The workflow has no jobs yet. Add a job.')
  if (def.jobs.length > MAX_JOBS) add('shape', 'jobs', `A workflow can have at most ${MAX_JOBS} jobs; this one has ${def.jobs.length}.`)

  // Workflow inputs.
  const inputs = new Map<string, (typeof def.inputs)[number]>()
  def.inputs.forEach((input, n) => {
    const path = `inputs.${input.key || n}`
    if (!KEY.test(input.key)) add('shape', path, `Input key "${input.key}" must start with a letter and use only letters, digits, - and _ (up to 40).`)
    if (inputs.has(input.key)) add('duplicate-key', path, `Two inputs are called "${input.key}". Input keys must be unique.`)
    else inputs.set(input.key, input)
    if (!input.label.trim()) add('empty', `${path}.label`, `Input "${input.key}" needs a label for the run form.`)
    checkOptions(input, path, `Input "${input.label || input.key}"`)
    if (input.default !== undefined) {
      const wrong = checkValue(input.default, typeOf(input))
      if (wrong) add('bad-default', `${path}.default`, `The default for input "${input.label || input.key}" ${wrong}; the input is ${describeType(typeOf(input))}.`)
    }
  })

  function checkOptions(o: { type: string; options?: string[] }, path: string, what: string): void {
    if (o.type === 'enum') {
      if (!o.options?.length) add('bad-option', `${path}.options`, `${what} is a choice but has no options. Add at least one.`)
      else if (new Set(o.options).size !== o.options.length) add('bad-option', `${path}.options`, `${what} lists the same option twice.`)
    } else if (o.options !== undefined) add('bad-option', `${path}.options`, `${what} has options, but only a choice (enum) can.`)
  }

  // Job ids first, so references can be checked in any order.
  const jobs = new Map<string, WorkflowJob>()
  def.jobs.forEach((job, n) => {
    const path = `jobs.${job.id || n}`
    if (!KEY.test(job.id)) add('shape', path, `Job id "${job.id}" must start with a letter and use only letters, digits, - and _ (up to 40).`, job.id)
    if (jobs.has(job.id)) add('duplicate-key', path, `Two jobs have the id "${job.id}". Job ids must be unique.`, job.id)
    else jobs.set(job.id, job)
  })

  /** What a reference to another job's output gives, or null after reporting why it can't be read. */
  const outputSource = (ref: { job: string; output: string }, path: string, reader: WorkflowJob | null): Source | null => {
    const who = reader ? `Job ${named(reader)}` : 'The workflow'
    if (reader && ref.job === reader.id) {
      add('cycle', path, `${who} reads its own output "${ref.output}". A job can only use outputs of jobs before it.`, reader.id)
      return null
    }
    const source = jobs.get(ref.job)
    if (!source) {
      add('dangling-job', path, `${who} reads "${ref.output}" from a job "${ref.job}" that isn't in this workflow. Pick another output or remove the binding.`, reader?.id)
      return null
    }
    // A job whose action is unknown has unknown outputs; its own issue says so, without one per reader.
    if (!findAction(catalog, source.action)) return null
    const outs = jobOutputs(source, catalog)
    const out = outs.find((o) => o.key === ref.output)
    if (!out) {
      const have = outs.length ? `Its outputs are: ${outs.map((o) => o.key).join(', ')}.` : 'It has no outputs.'
      add('dangling-output', path, `${who} reads "${ref.output}" from ${named(source)}, but ${named(source)} has no output called "${ref.output}". ${have}`, reader?.id)
      return null
    }
    return { type: typeOf(out), optional: out.required === false, label: `${source.name || source.id} → ${out.label || out.key}` }
  }

  const inputSource = (key: string, path: string, reader: WorkflowJob): Source | null => {
    const input = inputs.get(key)
    if (!input) {
      add('dangling-input', path, `Job ${named(reader)} uses a workflow input "${key}" that doesn't exist. Add the input or pick another value.`, reader.id)
      return null
    }
    return { type: typeOf(input), optional: input.required === false && input.default === undefined, label: `input "${input.label || input.key}"` }
  }

  /** Checks a source fills a parameter: type, and presence when the parameter is required. */
  const fits = (src: Source, param: ParamSpec, path: string, job: WorkflowJob): void => {
    const want = typeOf(param)
    if (!assignable(src.type, want)) {
      add('type-mismatch', path, `${param.label} of ${named(job)} needs ${describeType(want)}, but ${src.label} is ${describeType(src.type)}.`, job.id)
    } else if (src.optional && param.required !== false && param.default === undefined) {
      add('missing-input', path, `${param.label} of ${named(job)} is required, but ${src.label} can be left empty. Make that required or give it a default.`, job.id)
    }
  }

  const partSource = (part: Exclude<TemplatePart, string>, path: string, job: WorkflowJob): Source | null =>
    'input' in part ? inputSource(part.input, path, job) : outputSource(part, path, job)

  const checkBinding = (b: Binding, param: ParamSpec, path: string, job: WorkflowJob): void => {
    switch (b.from) {
      case 'const': {
        const wrong = checkValue(b.value, typeOf(param))
        if (wrong) add('type-mismatch', path, `${param.label} of ${named(job)} ${wrong}; it was given ${describeType({ type: typeOfValue(b.value) ?? 'text' })}.`, job.id)
        return
      }
      case 'input': {
        const src = inputSource(b.input, path, job)
        if (src) fits(src, param, path, job)
        return
      }
      case 'job': {
        const src = outputSource(b, path, job)
        if (src) fits(src, param, path, job)
        return
      }
      case 'template': {
        if (param.type !== 'text') {
          add('type-mismatch', path, `${param.label} of ${named(job)} needs ${describeType(typeOf(param))}, so it can't be text with values filled in.`, job.id)
          return
        }
        b.parts.forEach((part, i) => {
          if (typeof part === 'string') return
          const where = `${path}.parts.${i}`
          const src = partSource(part, where, job)
          if (src?.type.type === 'text-list') add('type-mismatch', where, `${src.label} is a list, so it can't go into the text of ${param.label} of ${named(job)}.`, job.id)
        })
        return
      }
      case 'list': {
        if (param.type !== 'text-list') {
          add('type-mismatch', path, `${param.label} of ${named(job)} needs ${describeType(typeOf(param))}, not a list.`, job.id)
          return
        }
        // An item whose source is empty is left out of the list, so items can be optional.
        const item: ParamSpec = { key: param.key, label: `Each item of ${param.label}`, type: 'text', required: false }
        b.items.forEach((it, i) => checkBinding(it, item, `${path}.items.${i}`, job))
      }
    }
  }

  // Jobs.
  for (const job of jobs.values()) {
    const path = `jobs.${job.id}`
    if (!job.name.trim()) add('empty', `${path}.name`, `Job "${job.id}" needs a name.`, job.id)
    const action = findAction(catalog, job.action)
    if (!job.action) add('unknown-action', `${path}.action`, `Job ${named(job)} has no action. Choose what it does.`, job.id)
    else if (!action) {
      add('unknown-action', `${path}.action`, `Job ${named(job)} uses an action "${job.action}" this Patchbay doesn't have. Available: ${catalog.filter((a) => !a.unavailable).map((a) => a.id).join(', ')}.`, job.id)
    } else if (action.unavailable) add('action-unavailable', `${path}.action`, `Job ${named(job)} can't run: ${action.unavailable}`, job.id)

    if (action) {
      for (const param of action.params) {
        const b = job.inputs[param.key]
        const where = `${path}.inputs.${param.key}`
        if (b) checkBinding(b, param, where, job)
        else if (param.required !== false && param.default === undefined) {
          add('missing-input', where, `${param.label} of ${named(job)} isn't set. Choose a value, a workflow input or an earlier job's output.`, job.id)
        }
      }
      for (const key of Object.keys(job.inputs)) {
        if (!action.params.some((p) => p.key === key)) {
          add('unknown-parameter', `${path}.inputs.${key}`, `Job ${named(job)} sets "${key}", which ${action.label} doesn't take. It takes: ${action.params.map((p) => p.key).join(', ')}.`, job.id)
        }
      }
      if (job.outputs?.length && !action.customOutputs) {
        add('outputs-not-allowed', `${path}.outputs`, `${action.label} has fixed outputs (${action.outputs.map((o) => o.key).join(', ')}), so job ${named(job)} can't declare its own.`, job.id)
      }
    }

    const outKeys = new Set<string>()
    jobOutputs(job, catalog).forEach((o, i) => {
      const where = `${path}.outputs.${o.key || i}`
      if (!KEY.test(o.key)) add('shape', where, `Output key "${o.key}" of ${named(job)} must start with a letter and use only letters, digits, - and _.`, job.id)
      if (outKeys.has(o.key)) add('duplicate-key', where, `Job ${named(job)} has two outputs called "${o.key}".`, job.id)
      outKeys.add(o.key)
      checkOptions(o, where, `Output "${o.key}" of ${named(job)}`)
    })

    for (const dep of job.after ?? []) {
      if (dep === job.id) add('cycle', `${path}.after`, `Job ${named(job)} waits for itself.`, job.id)
      else if (!jobs.has(dep)) add('dangling-job', `${path}.after`, `Job ${named(job)} waits for a job "${dep}" that isn't in this workflow.`, job.id)
    }

    const { retries, timeoutMs } = job.limits ?? {}
    if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES)) {
      add('bad-limit', `${path}.limits.retries`, `Retries for ${named(job)} must be a whole number from 0 to ${MAX_RETRIES}.`, job.id)
    }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) {
      add('bad-limit', `${path}.limits.timeoutMs`, `The time limit for ${named(job)} must be at least a second.`, job.id)
    }
  }

  for (const loop of findCycles(def)) {
    if (loop.length <= 2) continue // A job reading itself was reported above.
    const names = loop.map((id) => jobs.get(id)?.name || id)
    add('cycle', `jobs.${loop[0]}`, `These jobs depend on each other in a loop: ${names.join(' → ')}. Workflows run in one direction; remove one of the links.`, loop[0])
  }

  // Workflow outputs.
  const outs = new Set<string>()
  ;(def.outputs ?? []).forEach((o, n) => {
    const path = `outputs.${o.key || n}`
    if (!KEY.test(o.key)) add('shape', path, `Workflow output key "${o.key}" must start with a letter and use only letters, digits, - and _.`)
    if (outs.has(o.key)) add('duplicate-key', path, `Two workflow outputs are called "${o.key}".`)
    outs.add(o.key)
    outputSource(o.from, `${path}.from`, null)
  })

  return issues
}

/**
 * Reads and validates a definition from parsed JSON in one go, as authoring tools need: a shape problem comes back as
 * one issue instead of an exception.
 */
export function readAndValidate(raw: unknown, catalog: ActionCatalog = BUILT_IN_ACTIONS): { definition?: WorkflowDefinition; issues: ValidationIssue[] } {
  try {
    const definition = readDefinition(raw)
    return { definition, issues: validateDefinition(definition, catalog) }
  } catch (e) {
    if (e instanceof WorkflowShapeError) return { issues: [{ code: e.code, path: e.path, message: e.message }] }
    throw e
  }
}
