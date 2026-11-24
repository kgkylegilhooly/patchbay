import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CanvasStore } from '../../shared/contract'
import type { CanvasDoc, CanvasNode, Edge } from '../../shared/model'
import { expectedWorktreePath, planRecipe, type Recipe, type RecipeEntry, type RecipeParams, type RecipePlan, type RecipeStartResult } from '../../shared/recipe'
import type { AfterGate } from '../control/after'
import type { NodeRunner } from '../sessions/nodeRunner'
import { findRecipe, listRecipes, REPO_RECIPES, saveRecipeFile } from './files'
import type { SetupGate } from './setupGate'
import { placeInProject, placeNear, projectOf as nodeProject } from '../../core/canvas/place'
import { spotNear } from '../control/verbs'
import { viewSize } from '../viewSize'
import { agentsNow } from '../agentsAllowed'

const MAX_TASK_CHARS = 4000

export interface RecipeServiceDeps {
  store: CanvasStore
  runner: Pick<NodeRunner, 'startNode'>
  gate: Pick<AfterGate, 'arm'>
  setupGate: Pick<SetupGate, 'hold'>
  /** Patchbay's data folder: personal recipes and setup plans live under it. */
  dataDir: string
  /** resources/launch-run.cjs, which runs a setup step's program with no shell. */
  launcher: string
  /** The repository root a folder is in, or null. */
  toplevel(folder: string): Promise<string | null>
  createWorktree(a: { repo: string; branch: string }): Promise<{ path: string; branch: string; repo: string }>
  newId?: () => string
}

export interface StartRequest {
  projectId: string
  ref: string
  /** The content the preview showed, from list. Start is refused if the recipe no longer matches it. */
  hash?: string
  params: RecipeParams
  /** Where the recipe's group goes. Absent means beside what's in the project already. */
  at?: { x: number; y: number }
  /** The agent that asked, which then opened the nodes and is linked to its agents. Absent for the person. */
  openedBy?: string
}

/** Forward slashes and double quotes read the same in Git Bash, PowerShell and cmd. */
const quoted = (path: string): string => `"${path.replace(/\\/g, '/')}"`

const sourceLabel = (e: RecipeEntry): string => (e.file ? `${e.source}, ${e.file}` : e.source)

export type RecipeService = ReturnType<typeof createRecipeService>

export function createRecipeService(d: RecipeServiceDeps) {
  const newId = d.newId ?? randomUUID
  const personalDir = join(d.dataDir, 'recipes')
  const plansDir = join(personalDir, 'plans')

  const projectOf = (projectId: string) => d.store.get().projects.find((p) => p.id === projectId)

  const repoFor = async (projectId: string): Promise<{ repo: string | null; folder: string }> => {
    const folder = projectOf(projectId)?.folder ?? ''
    return { repo: folder ? await d.toplevel(folder).catch(() => null) : null, folder }
  }

  const list = async (projectId: string): Promise<{ entries: RecipeEntry[]; repo: string | null; folder: string }> => {
    const { repo, folder } = await repoFor(projectId)
    return { entries: listRecipes(personalDir, repo), repo, folder }
  }

  /** Checks the parameters before anything changes. Returns the reason they can't be used, or null. */
  const problemWith = (recipe: Recipe, p: RecipeParams): string | null => {
    if (typeof p.task !== 'string' || p.task.length > MAX_TASK_CHARS) return `The task must be text of at most ${MAX_TASK_CHARS} characters.`
    if (p.worktree) {
      if (!p.branch?.trim()) return 'Enter a branch for the new worktree.'
      if (!p.repo?.trim()) return 'Choose the repository to make the worktree from.'
    } else {
      if (!p.cwd || !isAbsolute(p.cwd)) return 'Choose a working directory, as a full path.'
      try {
        if (!statSync(p.cwd).isDirectory()) return `Not a folder: ${p.cwd}`
      } catch {
        return `Folder not found: ${p.cwd}`
      }
    }
    for (const n of recipe.nodes) {
      const run = p.runs?.[n.key]
      if (run !== undefined && (!Array.isArray(run) || !run.length || !run[0] || !run.every((a) => typeof a === 'string'))) return `Setup step "${n.title}" needs a program to run.`
    }
    return null
  }

  /** What starting would make, with the worktree's folder as it will be. Runs nothing. */
  const preview = (entry: RecipeEntry, p: RecipeParams): RecipePlan => {
    const cwd = p.worktree && p.repo && p.branch ? expectedWorktreePath(p.repo, p.branch) : p.cwd
    return planRecipe(entry.recipe!, { ...p, cwd }, newId, agentsNow())
  }

  /** Beside the opener, or where the person is looking in the project. See core/canvas/place. */
  const spot = (doc: CanvasDoc, projectId: string, size: { width: number; height: number }, openedBy?: string): { x: number; y: number } => {
    const opener = openedBy ? doc.nodes.find((n) => n.id === openedBy) : undefined
    if (opener && nodeProject(doc, opener) === projectId) return spotNear(doc, opener, size)
    return placeInProject(doc, projectId, size, viewSize())
  }

  /**
   * Makes the recipe's nodes and starts it: the worktree first, then the nodes and their connections, then holds for
   * the agents that wait, then the setup steps. Everything that can be checked is checked before the first change.
   */
  const start = async (req: StartRequest): Promise<RecipeStartResult | { ok: false; reason: string }> => {
    const project = projectOf(req.projectId)
    if (!project) return { ok: false, reason: 'That project is gone.' }
    const { entries } = await list(req.projectId)
    const found = findRecipe(entries, req.ref)
    if (!found.ok) return { ok: false, reason: found.problem }
    const entry = found.entry
    const recipe = entry.recipe!
    // Start runs what the preview showed, or nothing: a file changed since, as by an agent in that checkout, is refused.
    // A repository's own recipe is written by whoever wrote the repository, so it must come with the hash it was shown with.
    if (entry.source === 'repository' && req.hash === undefined) {
      return { ok: false, reason: `The recipe "${recipe.name}" comes from the repository${entry.file ? ` (${entry.file})` : ''}. Look at it before starting it.` }
    }
    if (req.hash !== undefined && req.hash !== entry.hash) {
      return { ok: false, reason: `The recipe "${recipe.name}" has changed since it was shown${entry.file ? ` (${entry.file})` : ''}. Look at it again before starting it.` }
    }
    const params: RecipeParams = { ...req.params, task: req.params.task ?? '', branch: (req.params.branch ?? '').trim(), repo: req.params.repo ?? '', cwd: req.params.cwd ?? '' }
    const problem = problemWith(recipe, params) ?? preview(entry, params).problems[0] ?? null
    if (problem) return { ok: false, reason: problem }

    let worktree: { path: string; branch: string; repo: string } | null = null
    let cwd = params.cwd
    if (params.worktree) {
      try {
        worktree = await d.createWorktree({ repo: params.repo, branch: params.branch })
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
      cwd = worktree.path
    }
    let added = 0
    try {
      const plan = planRecipe(recipe, { ...params, cwd, repo: worktree?.repo ?? params.repo }, newId, agentsNow())
      // Checked again against the worktree's real folder, which a value in the commands may now include.
      if (plan.problems.length) throw new Error(plan.problems[0])
      return await make(req, entry, plan, worktree, () => added++)
    } catch (e) {
      // Nothing is taken back: the worktree may hold work, and the nodes show what ran. The person is told what's left.
      const left = [worktree && `the worktree ${worktree.path} on branch ${worktree.branch}`, added && `${added} node${added === 1 ? '' : 's'} on the canvas`].filter(Boolean)
      return { ok: false, reason: `${(e as Error).message}${left.length ? ` Left in place: ${left.join(' and ')}.` : ''}` }
    }
  }

  /** Writes the setup plans, adds the nodes and links, holds the waiting agents and starts the rest. */
  const make = async (
    req: StartRequest,
    entry: RecipeEntry,
    plan: RecipePlan,
    worktree: { path: string; branch: string; repo: string } | null,
    counted: () => void
  ): Promise<RecipeStartResult> => {
    // The setup plans are written before their nodes exist, so each node's command is final when it's added.
    const label = `"${entry.recipe!.name}" (${sourceLabel(entry)})`
    mkdirSync(plansDir, { recursive: true })
    const commands = new Map<string, string>()
    plan.setup.forEach((step, i) => {
      const file = join(plansDir, `${step.id}.json`)
      const note = `Setup step ${i + 1} of ${plan.setup.length} from recipe ${label}. Agents that wait for setup start when every step exits with code 0.`
      writeFileSync(file, JSON.stringify({ file: step.argv[0], args: step.argv.slice(1), cwd: step.cwd, env: {}, note }))
      commands.set(step.id, `node ${quoted(d.launcher)} ${quoted(file)}`)
    })

    const project = projectOf(req.projectId)!
    const doc = d.store.get()
    // A spot asked for is kept when it's free, and otherwise moved just far enough to be clear.
    const at = req.at ? placeNear(doc, { at: req.at, size: plan.frame, projectId: project.id }) : spot(doc, project.id, plan.frame, req.openedBy)
    const own = { projectId: project.id, ...(req.openedBy ? { openedBy: req.openedBy } : {}) }
    d.store.dispatch({ op: 'addNode', node: { ...plan.frame, ...own, x: Math.round(at.x), y: Math.round(at.y), worktree } })
    counted()
    for (const node of plan.nodes) {
      const command = commands.get(node.id)
      d.store.dispatch({ op: 'addNode', node: { ...node, ...own, ...(command ? { command } : {}) } as CanvasNode })
      counted()
    }
    const edges: Edge[] = [...plan.edges]
    if (req.openedBy) {
      edges.push({ id: newId(), from: req.openedBy, to: plan.frame.id, kind: 'opened' })
      // As with a team: the agent that asked can read and message the agents it made.
      for (const n of plan.nodes) if (n.kind === 'claude') edges.push({ id: newId(), from: req.openedBy, to: n.id, kind: 'opened' }, { id: newId(), from: req.openedBy, to: n.id, kind: 'link' })
    }
    for (const edge of edges) d.store.dispatch({ op: 'addEdge', edge })

    for (const [id, hold] of Object.entries(plan.holds)) d.setupGate.hold(id, { ...hold, recipe: label })
    for (const [id, after] of Object.entries(plan.after)) d.gate.arm(id, after)
    for (const id of plan.starts) await d.runner.startNode(id)
    for (const step of plan.setup) await d.runner.startNode(step.id)
    return { ok: true, group: plan.frame.id, ids: plan.ids, worktree: worktree && { path: worktree.path, branch: worktree.branch } }
  }

  /** Removes setup plans whose run node is no longer on the canvas. Returns how many went. */
  const prunePlans = (): number => {
    let names: string[]
    try {
      names = readdirSync(plansDir)
    } catch {
      return 0
    }
    const present = new Set(d.store.get().nodes.map((n) => n.id))
    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.json') || present.has(name.slice(0, -5))) continue
      try {
        rmSync(join(plansDir, name), { force: true })
        removed++
      } catch {
        // In use or already gone: tried again next time.
      }
    }
    return removed
  }

  const save = async (a: { projectId: string; recipe: Recipe; where: 'personal' | 'repository'; overwrite?: boolean }): Promise<{ ok: true; file: string } | { ok: false; reason: string; exists?: boolean }> => {
    let dir = personalDir
    if (a.where === 'repository') {
      const { repo } = await repoFor(a.projectId)
      if (!repo) return { ok: false, reason: "This project's folder isn't in a git repository, so the recipe can't be saved there." }
      dir = join(repo, REPO_RECIPES)
    }
    try {
      return await saveRecipeFile(dir, a.recipe, !!a.overwrite)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  const folderFor = async (projectId: string, where: 'personal' | 'repository'): Promise<string | null> => {
    if (where === 'personal') return personalDir
    const { repo } = await repoFor(projectId)
    return repo ? join(repo, REPO_RECIPES) : null
  }

  return { list, preview, start, save, folderFor, problemWith, prunePlans }
}

