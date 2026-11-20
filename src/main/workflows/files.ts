import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../../core/persist/atomicFile'
import type { RecipeSource } from '../../shared/recipe'
import { readWorkflowShape, workflowFileName, workflowIssues, WorkflowError, type Workflow, type WorkflowIssue } from '../../shared/workflow'
import type { WorkflowEntry } from '../../shared/workflowBridge'
import { readDefinitionFolder, recipeHash } from '../recipes/files'

export type { WorkflowEntry }

/** Where a repository keeps its workflows, from its root. */
export const REPO_WORKFLOWS = join('.patchbay', 'workflows')

/** The same rule as recipes: a hash of the definition as read. */
export const workflowHash = (wf: Workflow): string => recipeHash(wf)

function entryOf(source: RecipeSource, wf: Workflow, file?: string): WorkflowEntry {
  const issues = workflowIssues(wf)
  return {
    ref: `${source}:${wf.name || file || 'workflow'}`,
    source,
    name: wf.name,
    ...(wf.description ? { description: wf.description } : {}),
    ...(file ? { file } : {}),
    workflow: wf,
    hash: workflowHash(wf),
    ...(issues.length ? { problem: issues.length === 1 ? issues[0].message : `${issues[0].message} (and ${issues.length - 1} more)`, issues } : {})
  }
}

/**
 * Reads every workflow in a folder. A workflow that reads but has issues is listed with them, so the editor can open
 * it to fix them; it can't be started until they're fixed.
 */
export function readWorkflowFolder(dir: string, source: Exclude<RecipeSource, 'built-in'>): WorkflowEntry[] {
  return readDefinitionFolder(dir, readWorkflowShape).map((r) => {
    if ('problem' in r) return { ref: `${source}:${r.fileName}`, source, name: r.fileName.replace(/\.json$/i, ''), file: r.file, problem: r.problem }
    return entryOf(source, r.value, r.file)
  })
}

const ORDER: Record<RecipeSource, number> = { repository: 0, personal: 1, 'built-in': 2 }

/** Every workflow from the repository, personal and built-in sources, in that order of precedence. Nothing merged. */
export function listWorkflows(personalDir: string, repoRoot: string | null, builtIn: readonly Workflow[] = []): WorkflowEntry[] {
  const entries = [
    ...(repoRoot ? readWorkflowFolder(join(repoRoot, REPO_WORKFLOWS), 'repository') : []),
    ...readWorkflowFolder(personalDir, 'personal'),
    ...builtIn.map((wf) => entryOf('built-in', wf))
  ]
  return entries.sort((a, b) => ORDER[a.source] - ORDER[b.source])
}

/** Finds a workflow by `source:name`, or by name alone (first in precedence order). Names compare without case. */
export function findWorkflow(entries: WorkflowEntry[], ref: string): { ok: true; entry: WorkflowEntry & { workflow: Workflow; hash: string } } | { ok: false; problem: string } {
  const exact = entries.find((e) => e.ref.toLowerCase() === ref.toLowerCase())
  const byName = entries.filter((e) => e.name.toLowerCase() === ref.toLowerCase())
  const hit = exact ?? byName.find((e) => e.workflow && !e.problem) ?? byName[0]
  if (!hit) return { ok: false, problem: `There's no workflow called "${ref}". Run patchbay workflows to see them.` }
  if (!hit.workflow || hit.problem) return { ok: false, problem: `The workflow "${hit.name}" can't be started: ${hit.problem}` }
  return { ok: true, entry: hit as WorkflowEntry & { workflow: Workflow; hash: string } }
}

/**
 * Saves a workflow file. One with issues still saves, so work in progress isn't lost; one that can't be represented
 * doesn't. Refuses to replace another file unless asked.
 */
export async function saveWorkflowFile(dir: string, raw: unknown, opts: { overwrite: boolean; file?: string }):
  Promise<{ ok: true; file: string; workflow: Workflow; hash: string; issues: WorkflowIssue[] } | { ok: false; reason: string; exists?: boolean }> {
  let wf: Workflow
  try { wf = readWorkflowShape(raw) } catch (e) {
    if (e instanceof WorkflowError) return { ok: false, reason: e.message }
    throw e
  }
  if (!wf.name) return { ok: false, reason: 'Give the workflow a name before saving it.' }
  const file = opts.file ?? join(dir, workflowFileName(wf.name))
  if (!opts.overwrite && existsSync(file)) return { ok: false, reason: `There's already a workflow file ${file}.`, exists: true }
  mkdirSync(dir, { recursive: true })
  await writeAtomic(file, `${JSON.stringify(wf, null, 2)}\n`)
  return { ok: true, file, workflow: wf, hash: workflowHash(wf), issues: workflowIssues(wf) }
}
