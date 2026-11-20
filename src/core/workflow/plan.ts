import { jobDependencies, type Binding, type WorkflowDefinition } from '../../shared/workflow'

/** Each job's dependencies that exist in the definition, by job id. Dangling ones are validation's to report. */
export function dependencyGraph(def: WorkflowDefinition): Map<string, string[]> {
  const ids = new Set(def.jobs.map((j) => j.id))
  return new Map(def.jobs.map((j) => [j.id, jobDependencies(j).filter((d) => ids.has(d))]))
}

/**
 * Every dependency cycle, each as the jobs around it with the first repeated at the end (a → b → a). Each cycle is
 * reported once, starting from the job earliest in the outline.
 */
export function findCycles(def: WorkflowDefinition): string[][] {
  const graph = dependencyGraph(def)
  const order = def.jobs.map((j) => j.id)
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const cycles: string[][] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    state.set(id, 'open')
    stack.push(id)
    for (const dep of graph.get(id) ?? []) {
      if (state.get(dep) === 'open') {
        const loop = stack.slice(stack.indexOf(dep))
        // Read in the direction work flows: the dependency first.
        const flow = [...loop].reverse()
        const start = flow.reduce((best, j) => (order.indexOf(j) < order.indexOf(best) ? j : best))
        const at = flow.indexOf(start)
        const rotated = [...flow.slice(at), ...flow.slice(0, at)]
        const key = [...rotated].sort().join('\0')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push([...rotated, start])
        }
      } else if (!state.has(dep)) visit(dep)
    }
    stack.pop()
    state.set(id, 'done')
  }
  for (const id of order) if (!state.has(id)) visit(id)
  return cycles
}

/**
 * The order jobs can run in: dependencies first, otherwise outline order. Null when there's a cycle. Duplicate job
 * ids keep the first.
 */
export function executionOrder(def: WorkflowDefinition): string[] | null {
  const graph = dependencyGraph(def)
  const outline = [...new Set(def.jobs.map((j) => j.id))]
  const done = new Set<string>()
  const result: string[] = []
  while (result.length < outline.length) {
    const next = outline.find((id) => !done.has(id) && (graph.get(id) ?? []).every((d) => done.has(d)))
    if (next === undefined) return null
    done.add(next)
    result.push(next)
  }
  return result
}

/** Every job that depends, directly or not, on `jobId`, in outline order. */
export function downstreamOf(def: WorkflowDefinition, jobId: string): string[] {
  const graph = dependencyGraph(def)
  const hit = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const [id, deps] of graph) {
      if (!hit.has(id) && id !== jobId && deps.some((d) => d === jobId || hit.has(d))) {
        hit.add(id)
        grew = true
      }
    }
  }
  return def.jobs.map((j) => j.id).filter((id) => hit.has(id))
}

function bindingReads(b: Binding, jobId: string, output?: string): boolean {
  switch (b.from) {
    case 'job': return b.job === jobId && (output === undefined || b.output === output)
    case 'template': return b.parts.some((p) => typeof p === 'object' && 'job' in p && p.job === jobId && (output === undefined || p.output === output))
    case 'list': return b.items.some((i) => bindingReads(i, jobId, output))
    default: return false
  }
}

/**
 * Where a job's outputs (or one of them) are used: which job parameters and workflow outputs read them. What the
 * editor lists before an output or job is deleted.
 */
export function usesOf(def: WorkflowDefinition, jobId: string, output?: string): Array<{ jobId: string; param: string } | { workflowOutput: string }> {
  const uses: Array<{ jobId: string; param: string } | { workflowOutput: string }> = []
  for (const job of def.jobs) {
    for (const [param, b] of Object.entries(job.inputs)) if (bindingReads(b, jobId, output)) uses.push({ jobId: job.id, param })
  }
  for (const o of def.outputs ?? []) if (o.from.job === jobId && (output === undefined || o.from.output === output)) uses.push({ workflowOutput: o.key })
  return uses
}
