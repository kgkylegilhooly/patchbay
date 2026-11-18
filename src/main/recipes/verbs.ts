import type { CanvasStore } from '../../shared/contract'
import { isSessionNode } from '../../shared/model'
import { branchFor, type RecipeParams, type RecipePlan } from '../../shared/recipe'
import type { Verbs } from '../control/verbs'
import { RpcRefusal } from '../control/server'
import { findRecipe } from './files'
import type { RecipeService } from './service'

export const RECIPE_VERBS = ['recipes', 'run-recipe']

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

/** What a plan makes, in the words an agent reads. */
function describePlan(plan: RecipePlan): unknown {
  const keyOf = new Map(Object.entries(plan.ids).map(([key, id]) => [id, key]))
  const named = (id: string): string => keyOf.get(id) ?? id
  return {
    group: plan.frame.title,
    nodes: plan.nodes.map((n) => ({
      key: named(n.id),
      kind: plan.setup.some((s) => s.id === n.id) ? 'setup' : n.kind === 'claude' ? (n.agent ?? 'claude') : n.kind,
      title: n.title,
      ...('cwd' in n ? { cwd: n.cwd } : {}),
      ...(n.kind === 'claude' && n.prompt ? { prompt: n.prompt } : {}),
      ...(plan.holds[n.id] ? { waitsForSetup: true } : {}),
      ...(plan.holds[n.id]?.after.length || plan.after[n.id] ? { startsAfter: (plan.holds[n.id]?.after ?? plan.after[n.id]).map(named) } : {})
    })),
    links: plan.edges.filter((e) => e.kind === 'link').map((e) => [named(e.from), named(e.to)]),
    runsOnStart: plan.runs,
    warnings: plan.warnings
  }
}

/**
 * Adds `patchbay recipes` and `patchbay run-recipe` to the verbs. Listing and previewing read files and run nothing.
 * Running makes the nodes in the caller's project, opened by the caller and linked to it, as a team is.
 */
export function withRecipeVerbs(verbs: Verbs, { store, service }: { store: CanvasStore; service: RecipeService }): Verbs {
  return async (callerId, verb, args) => {
    if (!RECIPE_VERBS.includes(verb)) return verbs(callerId, verb, args)
    const caller = store.get().nodes.find((n) => n.id === callerId)
    if (!caller) refuse(`Node "${callerId}" is no longer on the canvas.`)
    const projectId = caller.projectId ?? store.get().activeProjectId
    const { entries, repo, folder } = await service.list(projectId)
    const name = optional(args, 'name')
    const source = optional(args, 'source')
    if (source !== undefined && !['built-in', 'personal', 'repository'].includes(source)) refuse('--source must be built-in, personal or repository.')

    if (verb === 'recipes' && name === undefined) {
      return {
        recipes: entries.map((e) => ({ name: e.name, source: e.source, ...(e.file ? { file: e.file } : {}), ...(e.description ? { description: e.description } : {}), ...(e.problem ? { problem: e.problem } : {}) })),
        precedence: 'When two recipes share a name, --name alone picks the repository one, then personal, then built-in. --source picks one.'
      }
    }
    if (!name) refuse('--name is required.')
    const lookup = findRecipe(entries, source ? `${source}:${name}` : name)
    if (!lookup.ok) refuse(lookup.problem)
    const found = lookup.entry
    const recipe = found.recipe!
    const task = optional(args, 'task') ?? ''
    const worktree = args.noWorktree === true ? false : recipe.worktree !== false
    const cwd = optional(args, 'cwd') ?? (isSessionNode(caller) ? caller.cwd : folder)
    const skip = args.skip === undefined ? [] : Array.isArray(args.skip) ? (args.skip as string[]) : refuse('--skip must be a list of setup step keys.')
    const params: RecipeParams = { task, branch: optional(args, 'branch') ?? (worktree ? branchFor(task) : ''), repo: optional(args, 'repo') ?? repo ?? cwd, cwd, worktree, skip }

    if (verb === 'recipes') {
      return { recipe: recipe.name, source: found.source, ...(found.file ? { file: found.file } : {}), worktree: worktree ? { branch: params.branch, repo: params.repo } : null, ...(describePlan(service.preview(found, params)) as object), note: 'Nothing has run. Use patchbay run-recipe with the same flags to start it.' }
    }
    const problem = service.problemWith(recipe, params)
    if (problem) refuse(problem)
    const result = await service.start({ projectId, ref: found.ref, params, openedBy: callerId })
    if (!result.ok) refuse(result.reason)
    return { group: result.group, nodes: result.ids, worktree: result.worktree }
  }
}
