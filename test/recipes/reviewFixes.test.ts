import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { withRecipeVerbs } from '../../src/main/recipes/verbs'
import type { ClaudeNode, RunNode } from '../../src/shared/model'
import { branchPatterns, folderIn, planRecipe, readRecipe, recipeFromSelection, secretsIn, type RecipeParams } from '../../src/shared/recipe'
import { BUILT_IN_RECIPES } from '../../src/shared/recipeBuiltins'
import { recipeWorld } from './fakes'

const at = { x: 24, y: 64, width: 560, height: 300 }
const params = (over: Partial<RecipeParams> = {}): RecipeParams => ({ task: 'Add dark mode', branch: 'dark-mode', repo: 'C:\\r', cwd: 'C:\\r', worktree: false, ...over })
const ids = () => {
  let n = 0
  return () => `id-${++n}`
}
const recipeWith = (nodes: unknown[]) => readRecipe({ schema: 1, name: 'R', nodes })

describe('M1: parameters in commands a shell runs', () => {
  const recipe = recipeWith([
    { key: 't', kind: 'terminal', title: 'Echo', command: 'echo {{task}}', layout: at },
    { key: 'r', kind: 'run', title: 'Build', command: 'npm run build -- {{branch}}', layout: at },
    { key: 's', kind: 'setup', title: 'Setup', run: ['node', 'x.js', '{{task}}'], layout: at }
  ])

  test('a value a shell would act on is refused, naming the node and the parameter', () => {
    const plan = planRecipe(recipe, params({ task: 'hi & del /q C:/x' }), ids())
    expect(plan.problems).toEqual([expect.stringMatching(/^"Echo" puts the task into a command your shell runs.*"&"/)])
  })

  test('the same value in a setup step is one argument with no shell, so it is allowed there', () => {
    const plan = planRecipe(recipeWith([{ key: 's', kind: 'setup', title: 'Setup', run: ['node', 'x.js', '{{task}}'], layout: at }]), params({ task: 'a & b' }), ids())
    expect(plan.problems).toEqual([])
    expect(plan.setup[0].argv).toEqual(['node', 'x.js', 'a & b'])
  })

  test('run commands are checked too, and plain values pass', () => {
    expect(planRecipe(recipe, params({ branch: 'x;rm' }), ids()).problems).toEqual([expect.stringMatching(/"Build" puts the branch/)])
    expect(planRecipe(recipe, params(), ids()).problems).toEqual([])
  })
})

test('M3: an SSH terminal is listed with what runs on Start', () => {
  const plan = planRecipe(recipeWith([{ key: 's', kind: 'terminal', title: 'Box', sshHost: 'build.example.com', layout: at }]), params(), ids())
  expect(plan.runs).toEqual([{ title: 'Box', what: 'ssh build.example.com', how: 'ssh', cwd: 'C:\\r' }])
})

describe('L1: folders that climb out of the working directory', () => {
  test('.. is worked out, and never climbs past the drive', () => {
    expect(folderIn('C:\\w\\repo', '../../Windows')).toBe('C:\\Windows')
    expect(folderIn('C:\\w\\repo', 'web/../api')).toBe('C:\\w\\repo\\api')
    expect(folderIn('C:\\w', '../../../..')).toBe('C:')
  })

  test('a relative folder that ends up outside it is warned about, one inside is not', () => {
    const out = planRecipe(recipeWith([{ key: 's', kind: 'setup', title: 'S', run: ['x'], folder: '../../Windows', layout: at }]), params({ cwd: 'C:\\w\\repo' }), ids())
    expect(out.warnings).toEqual([expect.stringContaining('C:\\Windows')])
    const inside = planRecipe(recipeWith([{ key: 's', kind: 'setup', title: 'S', run: ['x'], folder: 'web/../api', layout: at }]), params({ cwd: 'C:\\w\\repo' }), ids())
    expect(inside.warnings).toEqual([])
  })
})

describe('L2: saving a short branch name', () => {
  test('a plain word is only taken where it reads as a branch', () => {
    const fill = (text: string) => branchPatterns('docs').reduce((t, re) => t.replace(re, '{{branch}}'), text)
    expect(fill('Update the docs and fix typos in docs.')).toBe('Update the docs and fix typos in docs.')
    expect(fill('git checkout docs, then `docs`, in C:\\wt\\docs\\src')).toBe('git checkout {{branch}}, then `{{branch}}`, in C:\\wt\\{{branch}}\\src')
  })

  test('a name with a dash is taken wherever it stands alone', () => {
    const fill = (text: string) => branchPatterns('dark-mode').reduce((t, re) => t.replace(re, '{{branch}}'), text)
    expect(fill('Work on dark-mode, not dark-modes.')).toBe('Work on {{branch}}, not dark-modes.')
  })

  test('saving a selection keeps ordinary words', () => {
    const nodes = [
      { id: 'g', kind: 'group' as const, title: 'G', x: 0, y: 0, width: 800, height: 600, parentId: null, worktree: { path: 'C:\\wt\\docs', branch: 'docs', repo: 'C:\\r' } },
      { id: 'a', kind: 'claude' as const, title: 'A', x: 24, y: 64, width: 600, height: 400, parentId: 'g', cwd: 'C:\\wt\\docs', prompt: 'Update the docs. Then git switch docs.', sessionId: null, transcriptPath: null, after: [] }
    ]
    const { recipe } = recipeFromSelection(nodes, [], ['g'], { name: 'R', cwd: 'C:\\wt\\docs', branch: 'docs' })
    expect(recipe.nodes[0]).toMatchObject({ prompt: 'Update the docs. Then git switch {{branch}}.' })
  })
})

describe('H1: Start runs what the preview showed', () => {
  test('a recipe file changed since it was listed is refused, before anything is made', async () => {
    const w = recipeWorld()
    const dir = join(w.dataDir, 'recipes')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'mine.json')
    const recipe = (run: string[]) => JSON.stringify({ schema: 1, name: 'Mine', nodes: [{ key: 's', kind: 'setup', title: 'S', run, layout: at }, { key: 'a', kind: 'agent', layout: at }] })
    writeFileSync(file, recipe(['npm', 'install']))
    const shown = (await w.service.list('p1')).entries.find((e) => e.name === 'Mine')!
    expect(shown.hash).toMatch(/^[0-9a-f]{16}$/)
    writeFileSync(file, recipe(['powershell', '-c', 'evil']))
    const r = await w.service.start({ projectId: 'p1', ref: shown.ref, hash: shown.hash, params: params({ worktree: true }) })
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/has changed since it was shown/) })
    expect(w.worktrees).toEqual([])
    expect(w.store.get().nodes).toEqual([])
    // The unchanged recipe, with the hash it was shown with, starts.
    const again = (await w.service.list('p1')).entries.find((e) => e.name === 'Mine')!
    expect(await w.service.start({ projectId: 'p1', ref: again.ref, hash: again.hash, params: params({ worktree: true }) })).toMatchObject({ ok: true })
  })

  test('a problem in the plan is refused before the worktree is made', async () => {
    const w = recipeWorld()
    const dir = join(w.dataDir, 'recipes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'echo.json'), JSON.stringify({ schema: 1, name: 'Echo', nodes: [{ key: 't', kind: 'terminal', command: 'echo {{task}}', layout: at }] }))
    const r = await w.service.start({ projectId: 'p1', ref: 'Echo', params: params({ worktree: true, task: 'x | y' }) })
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/shell would act on/) })
    expect(w.worktrees).toEqual([])
  })
})

test('L3: a failure after the worktree is made says what was left behind', async () => {
  const w = recipeWorld()
  // A file where the plans folder goes, so writing the setup plan fails after the worktree exists.
  mkdirSync(join(w.dataDir, 'recipes'), { recursive: true })
  writeFileSync(join(w.dataDir, 'recipes', 'plans'), 'not a folder')
  const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ worktree: true, repo: process.cwd() }) })
  expect(r.ok).toBe(false)
  expect(!r.ok && r.reason).toMatch(/Left in place: the worktree .* on branch dark-mode/)
})

test('L4: plans of setup steps no longer on the canvas are pruned', async () => {
  const w = recipeWorld()
  const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ worktree: true, repo: process.cwd() }) })
  if (!r.ok) throw new Error(r.reason)
  const plans = join(w.dataDir, 'recipes', 'plans')
  writeFileSync(join(plans, 'gone-node.json'), '{}')
  expect(w.service.prunePlans()).toBe(1)
  expect(readdirSync(plans)).toEqual([`${r.ids.setup}.json`])
  w.store.dispatch({ op: 'removeNodes', ids: [r.ids.setup], at: 1 })
  expect(w.service.prunePlans()).toBe(1)
  expect(existsSync(join(plans, `${r.ids.setup}.json`))).toBe(false)
})

describe('M4 and L6: the setup hold', () => {
  const started = async () => {
    const w = recipeWorld()
    const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ worktree: true, repo: process.cwd() }) })
    if (!r.ok) throw new Error(r.reason)
    return { w, ids: r.ids }
  }

  test('a status no session reports, such as unknown or exited, keeps the hold and puts it back to queued', async () => {
    const { w, ids } = await started()
    w.tracker.apply(ids.implementer, { type: 'process-exit' })
    expect(w.agent(ids.implementer).setupWait).toBeDefined()
    expect(w.tracker.get(ids.implementer)).toBe('queued')
    w.tracker.seed(ids.implementer, 'unknown')
    expect(w.agent(ids.implementer).setupWait).toBeDefined()
    expect(w.tracker.get(ids.implementer)).toBe('queued')
    expect(w.runner.started).toEqual([ids.setup])
  })

  test('an agent the person started some other way loses its hold', async () => {
    const { w, ids } = await started()
    w.tracker.apply(ids.implementer, { type: 'launched' })
    expect(w.agent(ids.implementer).setupWait).toBeUndefined()
  })

  test('Start anyway on an agent that starts after another skips only the setup', async () => {
    const { w, ids } = await started()
    await w.setupGate.startAnyway(ids.reviewer)
    expect(w.runner.started).toEqual([ids.setup])
    expect(w.agent(ids.reviewer).setupWait).toBeUndefined()
    expect(w.agent(ids.reviewer).after).toEqual([ids.implementer])
    expect(w.tracker.get(ids.reviewer)).toBe('queued')
  })
})

describe('M2: agents and repository recipes', () => {
  const lead: ClaudeNode = { id: 'lead', kind: 'claude', title: 'Lead', x: 0, y: 0, width: 600, height: 400, parentId: null, projectId: 'p1', cwd: process.cwd(), sessionId: null, transcriptPath: null, after: [] }
  const repoWorld = () => {
    const repo = mkdtempSync(join(tmpdir(), 'pb-recipe-repo-'))
    mkdirSync(join(repo, '.patchbay', 'recipes'), { recursive: true })
    writeFileSync(join(repo, '.patchbay', 'recipes', 'setup.json'), JSON.stringify({ schema: 1, name: 'Setup', worktree: false, nodes: [{ key: 't', kind: 'terminal', sshHost: 'x.example.com', layout: at }] }))
    const w = recipeWorld([lead], repo)
    return { ...w, verbs: withRecipeVerbs(async () => ({}), { store: w.store, service: w.service }) }
  }

  test('an agent can preview a repository recipe but not start it', async () => {
    const w = repoWorld()
    const shown = (await w.verbs('lead', 'recipes', { name: 'Setup' })) as { source: string; runsOnStart: Array<{ what: string }>; hash: string }
    expect(shown.source).toBe('repository')
    expect(shown.runsOnStart.map((r) => r.what)).toEqual(['ssh x.example.com'])
    await expect(w.verbs('lead', 'run-recipe', { name: 'Setup' })).rejects.toThrow(/only the person can start it/)
    expect(w.store.get().nodes).toHaveLength(1)
  })

  test('run-recipe with a --hash that no longer matches is refused', async () => {
    const w = recipeWorld([lead])
    const verbs = withRecipeVerbs(async () => ({}), { store: w.store, service: w.service })
    await expect(verbs('lead', 'run-recipe', { name: 'Implement and review', task: 'T', hash: '0000000000000000' })).rejects.toThrow(/has changed/)
    const shown = (await verbs('lead', 'recipes', { name: 'Implement and review', task: 'T' })) as { hash: string }
    expect(await verbs('lead', 'run-recipe', { name: 'Implement and review', task: 'T', hash: shown.hash })).toMatchObject({ group: expect.any(String) })
    expect((w.store.get().nodes.find((n) => n.kind === 'run' && n.title.startsWith('Setup')) as RunNode).command).toContain('launch-run.cjs')
  })
})

describe('M5: node ids from outside the selection', () => {
  const lead = '1d015715-b71f-441e-bdfc-3333e6b4be2a'
  const worker = '2e126826-c820-452f-ace0-444405c5cf3b'
  const nodes = [
    { id: lead, kind: 'claude' as const, title: 'Lead', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: 'C:\r', sessionId: null, transcriptPath: null, after: [] },
    { id: worker, kind: 'claude' as const, title: 'Worker', x: 700, y: 0, width: 600, height: 400, parentId: null, cwd: 'C:\r', prompt: `When done: patchbay send --node ${lead} --text done. Old: 9f0e8d7c-6b5a-4938-a271-605f4e3d2c1b`, sessionId: null, transcriptPath: null, after: [] }
  ]

  test('saving lists them, by the name of the node they reach', () => {
    const { outside } = recipeFromSelection(nodes, [], [worker], { name: 'R', cwd: 'C:\r' })
    expect(outside).toEqual([
      { title: 'Worker', id: lead, names: '"Lead"' },
      { title: 'Worker', id: '9f0e8d7c-6b5a-4938-a271-605f4e3d2c1b', names: 'a node no longer on the canvas' }
    ])
  })

  test('selecting the node too makes it a reference to the new one instead', () => {
    const { outside, recipe } = recipeFromSelection(nodes, [], [worker, lead], { name: 'R', cwd: 'C:\r' })
    expect(outside.map((o) => o.id)).toEqual(['9f0e8d7c-6b5a-4938-a271-605f4e3d2c1b'])
    expect(JSON.stringify(recipe)).toContain('--node {{node:lead}}')
  })

  test('the preview warns about an id no node of this start has', () => {
    const recipe = recipeWith([{ key: 'w', kind: 'agent', title: 'Worker', prompt: `Report to ${lead}, and to {{node:w}}.`, layout: at }])
    const plan = planRecipe(recipe, params(), () => crypto.randomUUID())
    expect(plan.warnings).toEqual([expect.stringContaining(`names node ${lead}, which this start doesn't make`)])
  })
})

test('L7: a prompt naming a skipped setup step keeps the reference as written, with a warning', () => {
  const recipe = recipeWith([
    { key: 'setup', kind: 'setup', title: 'Setup', run: ['npm', 'ci'], layout: at },
    { key: 'a', kind: 'agent', title: 'Agent', prompt: 'Read {{node:setup}} output', layout: at }
  ])
  const plan = planRecipe(recipe, params({ skip: ['setup'] }), ids())
  expect(plan.ids.setup).toBeUndefined()
  expect((plan.nodes.find((n) => n.id === plan.ids.a) as ClaudeNode).prompt).toBe('Read {{node:setup}} output')
  expect(plan.warnings).toEqual([expect.stringContaining('names {{node:setup}}, which is left out of this start')])
})

describe('L8: secrets in what is saved', () => {
  const recipe = (over: Record<string, unknown>) => recipeWith([{ key: 'x', kind: 'terminal', title: 'X', layout: at, ...over }])
  test.each([
    [{ command: 'set GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 && npm publish' }, 'a GitHub token'],
    [{ command: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234' }, 'an API key (sk-…)'],
    [{ command: 'deploy --password=hunter2hunter2' }, 'a secret set to a value'],
    [{ command: 'git clone https://me:s3cr3t@example.com/r.git' }, 'a password in a URL']
  ])('%o is flagged as %s', (over, what) => {
    expect(secretsIn(recipe(over)).map((s) => s.what)).toContain(what)
  })

  test('a browser URL with a token in its query, and a note, are flagged too', () => {
    const r = recipeWith([
      { key: 'b', kind: 'browser', title: 'App', url: 'http://localhost:3000/?token=abc123', layout: at },
      { key: 'n', kind: 'note', title: 'Brief', text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', layout: at }
    ])
    expect(secretsIn(r)).toEqual([
      { title: 'App', what: 'a credential in a URL' },
      { title: 'Brief', what: 'a bearer token' }
    ])
  })

  test('ordinary commands are not flagged', () => {
    expect(secretsIn(recipe({ command: 'npm test -- --grep token' }))).toEqual([])
    expect(secretsIn(BUILT_IN_RECIPES[0])).toEqual([])
  })

  test('saving a selection reports them', () => {
    const nodes = [{ id: 't', kind: 'terminal' as const, title: 'Publish', x: 0, y: 0, width: 500, height: 300, parentId: null, cwd: 'C:\r', command: 'set NPM_TOKEN=npm_abcdefgh1234 && npm publish' }]
    expect(recipeFromSelection(nodes, [], ['t'], { name: 'R', cwd: 'C:\r' }).secrets).toEqual([{ title: 'Publish', what: 'a secret set to a value' }])
  })
})
