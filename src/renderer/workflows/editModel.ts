import { STEP_KEY, stepOutputs, templateRefs, type Binding, type InputSpec, type Step, type StepKind, type Workflow } from '../../shared/workflow'

/**
 * The outline editor's operations on a workflow, pure. Each returns a new workflow. Steps keep their keys when
 * renamed or moved, so what refers to them keeps working; what a change breaks shows up as issues, never silently.
 */

export function blankWorkflow(name = ''): Workflow {
  return { schema: 1, name, inputs: [{ key: 'brief', label: 'Brief', type: 'text' }], steps: [] }
}

/** A key from a title, unique among `taken`. */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let stem = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 30)
  if (!STEP_KEY.test(stem)) stem = 'step'
  let key = stem
  for (let n = 2; used.has(key); n++) key = `${stem}-${n}`
  return key
}

const TITLES: Record<StepKind, string> = { agent: 'Agent task', command: 'Run command', review: 'Review' }

export function newStep(kind: StepKind, wf: Workflow): Step {
  const key = uniqueKey(kind === 'agent' ? 'agent' : kind === 'command' ? 'command' : 'review', wf.steps.map((s) => s.key))
  switch (kind) {
    case 'agent': return { kind, key, title: TITLES.agent, agent: 'claude', prompt: '', outputs: [{ key: 'summary', label: 'Summary', type: 'text' }] }
    case 'command': return { kind, key, title: TITLES.command, run: [] }
    case 'review': return { kind, key, title: TITLES.review, question: 'Does this look right?', show: [] }
  }
}

export function addStep(wf: Workflow, kind: StepKind, at = wf.steps.length): { wf: Workflow; key: string } {
  const step = newStep(kind, wf)
  const steps = [...wf.steps]
  steps.splice(at, 0, step)
  return { wf: { ...wf, steps }, key: step.key }
}

export function updateStep(wf: Workflow, key: string, change: (s: Step) => Step): Workflow {
  return { ...wf, steps: wf.steps.map((s) => (s.key === key ? change(s) : s)) }
}

export function moveStep(wf: Workflow, key: string, by: -1 | 1): Workflow {
  const i = wf.steps.findIndex((s) => s.key === key)
  const j = i + by
  if (i < 0 || j < 0 || j >= wf.steps.length) return wf
  const steps = [...wf.steps]
  ;[steps[i], steps[j]] = [steps[j], steps[i]]
  return { ...wf, steps }
}

export function removeStep(wf: Workflow, key: string): Workflow {
  return { ...wf, steps: wf.steps.filter((s) => s.key !== key) }
}

/** Where a step's outputs (or one of them) are used, by step title: what deleting it would break. */
export function usesOfStep(wf: Workflow, key: string, output?: string): string[] {
  const hits = (t: string): boolean => templateRefs(t).some((r) => 'step' in r && r.step === key && (output === undefined || r.output === output))
  const shows = (b: Binding): boolean => 'step' in b && b.step === key && (output === undefined || b.output === output)
  return wf.steps.filter((s) => s.key !== key && (
    (s.kind === 'agent' && hits(s.prompt)) || (s.kind === 'command' && s.run.some(hits)) || (s.kind === 'review' && s.show.some(shows))
  )).map((s) => s.title)
}

/** Where an input is used, by step title. */
export function usesOfInput(wf: Workflow, key: string): string[] {
  const hits = (t: string): boolean => templateRefs(t).some((r) => 'input' in r && r.input === key)
  return wf.steps.filter((s) => (s.kind === 'agent' && hits(s.prompt)) || (s.kind === 'command' && s.run.some(hits)) || (s.kind === 'review' && s.show.some((b) => 'input' in b && b.input === key))).map((s) => s.title)
}

export interface Choice { label: string; token: string; binding: Binding; type: 'text' | 'file' | 'number' | 'boolean' | 'enum' }

/**
 * What a step can use, as the output picker shows it: the workflow's inputs, then each earlier step's outputs, such
 * as "Plan › Plan document".
 */
export function choicesFor(wf: Workflow, key: string): Choice[] {
  const index = wf.steps.findIndex((s) => s.key === key)
  const inputs: Choice[] = wf.inputs.filter((i) => STEP_KEY.test(i.key)).map((i) => ({ label: i.label || i.key, token: `{{in:${i.key}}}`, binding: { input: i.key }, type: i.type }))
  const outputs: Choice[] = wf.steps.slice(0, index < 0 ? wf.steps.length : index).flatMap((s) =>
    stepOutputs(s).filter((o) => STEP_KEY.test(o.key)).map((o) => ({ label: `${s.title} › ${o.label || o.key}`, token: `{{out:${s.key}.${o.key}}}`, binding: { step: s.key, output: o.key }, type: o.type })))
  return [...inputs, ...outputs]
}

/** The labelled values a text refers to, in order, for showing as chips. Unknown references are labelled as such. */
export function chipsIn(wf: Workflow, key: string, text: string): Array<{ token: string; label: string; known: boolean }> {
  const choices = choicesFor(wf, key)
  return templateRefs(text).map((r) => {
    const hit = choices.find((c) => c.token.replace(/\s/g, '') === r.whole.replace(/\s/g, ''))
    return { token: r.whole, label: hit?.label ?? r.whole, known: !!hit }
  })
}

/** Inserts a value's token into text at a position. */
export function insertAt(text: string, at: number, token: string): { text: string; caret: number } {
  const pos = Math.max(0, Math.min(at, text.length))
  return { text: text.slice(0, pos) + token + text.slice(pos), caret: pos + token.length }
}

export function addInput(wf: Workflow): Workflow {
  const key = uniqueKey('input', wf.inputs.map((i) => i.key))
  return { ...wf, inputs: [...wf.inputs, { key, label: 'New input', type: 'text' }] }
}

export function updateInput(wf: Workflow, index: number, change: Partial<InputSpec>): Workflow {
  return {
    ...wf,
    inputs: wf.inputs.map((i, n) => {
      if (n !== index) return i
      const next: InputSpec = { ...i, ...change }
      // Options belong to choices only; a default that no longer fits goes.
      if (next.type !== 'enum') delete next.options
      else next.options ??= ['option']
      if (change.type && change.type !== i.type) delete next.default
      for (const k of Object.keys(next) as Array<keyof InputSpec>) if (next[k] === undefined) delete next[k]
      return next
    })
  }
}

export function removeInput(wf: Workflow, index: number): Workflow {
  return { ...wf, inputs: wf.inputs.filter((_, n) => n !== index) }
}
