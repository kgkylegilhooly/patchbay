import type { CanvasStore } from '../../shared/contract'
import type { Verbs } from '../control/verbs'
import { RpcRefusal } from '../control/server'
import { archivedRefusal } from '../control/archived'
import { currentAttempt } from '../../core/workflow/engine'
import { STEP_KEY, type WorkflowRun } from '../../shared/workflow'
import { findWorkflow } from './files'
import type { RawOutput, WorkflowService } from './service'

export const WORKFLOW_VERBS = ['workflows', 'workflow-run', 'job-submit']

type Args = Record<string, unknown>

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

function optional(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') refuse(`--${key} must be text.`)
  return v
}

/** `--input key=value`, repeated. */
function inputsOf(args: Args): Record<string, string> {
  const raw = args.input
  if (raw === undefined) return {}
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) refuse('--input must be key=value.')
  const out: Record<string, string> = {}
  for (const item of raw as string[]) {
    const eq = item.indexOf('=')
    if (eq < 1) refuse(`--input ${item}: write it as key=value.`)
    out[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return out
}

/** The CLI sends `--output key=value` and `--output key=@file` as {key, text} and {key, file}. */
function outputsOf(args: Args): RawOutput[] {
  const raw = args.outputs ?? []
  if (!Array.isArray(raw)) refuse('--output must be key=value or key=@file.')
  return raw.map((o: unknown) => {
    const r = o as Record<string, unknown>
    if (!r || typeof r.key !== 'string' || !r.key) refuse('--output must be key=value or key=@file.')
    if (!STEP_KEY.test(r.key)) refuse(`--output ${JSON.stringify(r.key)}: a field name starts with a letter and has only letters, digits, - and _.`)
    if (typeof r.text === 'string') return { key: r.key, text: r.text }
    if (typeof r.file === 'string') return { key: r.key, file: r.file }
    return refuse(`--output ${r.key}: give a value, or @ and a file.`)
  })
}

/** What a run looks like to an agent. */
export function describeRun(run: WorkflowRun): unknown {
  return {
    id: run.id,
    workflow: run.definition.name,
    state: run.state,
    folder: run.cwd,
    ...(run.worktree ? { branch: run.worktree.branch } : {}),
    steps: run.definition.steps.map((s) => {
      const a = currentAttempt(run, s.key)
      return { key: s.key, title: s.title, kind: s.kind, state: a?.state ?? 'pending', ...(a?.n && a.n > 1 ? { attempt: a.n } : {}), ...(a?.nodeId ? { node: a.nodeId } : {}), ...(a?.why ? { why: a.why } : {}) }
    })
  }
}

/**
 * Adds the workflow verbs. Listing and previewing read files and run nothing. An agent may start only a personal
 * workflow the person has already started in exactly this version. `job-submit` is heard only from the node of the
 * step's current agent attempt: the node is the caller the control token names, never an argument.
 */
export function withWorkflowVerbs(verbs: Verbs, { store, service }: { store: CanvasStore; service: WorkflowService }): Verbs {
  return async (callerId, verb, args) => {
    if (!WORKFLOW_VERBS.includes(verb)) return verbs(callerId, verb, args)
    const caller = store.get().nodes.find((n) => n.id === callerId)
    if (!caller) refuse(`Node "${callerId}" is no longer on the canvas.`)
    const archived = archivedRefusal(store.get(), caller, {})
    if (archived) refuse(archived)

    if (verb === 'job-submit') {
      const r = await service.submit(callerId, outputsOf(args), optional(args, 'step'))
      if (!r.ok) refuse(r.message)
      return { submitted: true, run: describeRun(r.run), note: 'Your result is recorded. The workflow goes on without you; you can stop here.' }
    }

    const projectId = caller.projectId ?? store.get().activeProjectId
    const { entries } = await service.list(projectId)
    const name = optional(args, 'name')
    const source = optional(args, 'source')
    if (source !== undefined && !['built-in', 'personal', 'repository'].includes(source)) refuse('--source must be built-in, personal or repository.')

    if (verb === 'workflows' && name === undefined) {
      return {
        workflows: entries.map((e) => ({ name: e.name, source: e.source, ...(e.file ? { file: e.file } : {}), ...(e.description ? { description: e.description } : {}), ...(e.problem ? { problem: e.problem } : {}) })),
        runs: service.runs(projectId).slice(0, 10).map(describeRun),
        note: 'Workflows are JSON files; see patchbay guide workflows for how to write one. Agents can start only personal ones the person has started before, unchanged.'
      }
    }
    if (!name) refuse('--name is required.')
    const lookup = findWorkflow(entries, source ? `${source}:${name}` : name)
    if (!lookup.ok) refuse(lookup.problem)
    const { entry } = lookup
    const inputs = inputsOf(args)
    if (verb === 'workflows') {
      return {
        workflow: entry.name, source: entry.source, ...(entry.file ? { file: entry.file } : {}),
        runsIn: entry.workflow.worktree === false ? "the project's folder itself (no worktree of its own: its steps change that checkout directly)" : 'a new worktree and branch of its own',
        inputs: entry.workflow.inputs, steps: service.preview(entry.workflow, inputs), hash: entry.hash,
        note: 'Nothing has run. Use patchbay workflow-run with the same --name and --input flags, and --hash, to start exactly this.'
      }
    }
    const hash = optional(args, 'hash')
    const r = await service.start({ projectId, ref: entry.ref, inputs, by: { agent: callerId }, ...(hash !== undefined ? { hash } : {}) })
    if (!r.ok) refuse(r.problems && r.problems.length > 1 ? `${r.reason} Also: ${r.problems.slice(1).join(' ')}` : r.reason)
    return { started: describeRun(r.run), group: r.run.groupId, note: 'The run goes on by itself. patchbay workflows shows how it is going.' }
  }
}
