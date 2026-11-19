import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { findRecipe, listRecipes } from '../../src/main/recipes/files'
import type { RecipeParams } from '../../src/shared/recipe'
import type { ClaudeNode, GroupNode, RunNode } from '../../src/shared/model'
import { recipeWorld } from './fakes'

const params = (over: Partial<RecipeParams> = {}): RecipeParams => ({ task: 'Add dark mode', branch: 'dark-mode', repo: process.cwd(), cwd: process.cwd(), worktree: true, ...over })

test('listing and previewing a recipe runs nothing, makes no worktree and adds no node', async () => {
  const w = recipeWorld()
  const { entries } = await w.service.list('p1')
  expect(entries.map((e) => e.ref)).toContain('built-in:Implement and review')
  const plan = w.service.preview(entries[0], params())
  expect(plan.runs.length).toBeGreaterThan(0)
  expect(w.runner.started).toEqual([])
  expect(w.worktrees).toEqual([])
  expect(w.store.get().nodes).toEqual([])
  expect(existsSync(join(w.dataDir, 'recipes', 'plans'))).toBe(false)
})

test('starting makes a worktree group, its nodes and links, starts the setup step, and holds the agents', async () => {
  const w = recipeWorld()
  const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params() })
  if (!r.ok) throw new Error(r.reason)
  const group = w.node(r.group) as GroupNode
  expect(group.worktree).toMatchObject({ branch: 'dark-mode' })
  expect(w.worktrees).toEqual([{ repo: process.cwd(), branch: 'dark-mode' }])
  expect(w.runner.started).toEqual([r.ids.setup])
  expect(w.tracker.get(r.ids.implementer)).toBe('queued')
  expect(w.tracker.get(r.ids.reviewer)).toBe('queued')
  for (const id of [r.ids.implementer, r.ids.reviewer]) expect(w.agent(id).cwd).toBe(group.worktree!.path)
  const links = w.store.get().edges.filter((e) => e.kind === 'link').map((e) => [e.from, e.to])
  expect(links).toContainEqual([r.ids.implementer, r.ids.reviewer])
  expect(w.agent(r.ids.reviewer).prompt).toContain(`--node ${r.ids.implementer}`)
})

test('the setup step runs its argument list with no shell, and its output says where it came from', async () => {
  const w = recipeWorld()
  const r = await w.service.start({ projectId: 'p1', ref: 'built-in:Implement and review', params: params() })
  if (!r.ok) throw new Error(r.reason)
  const step = w.node(r.ids.setup) as RunNode
  expect(step.command).toMatch(/^node "C:\/app\/resources\/launch-run\.cjs" ".*\/recipes\/plans\/.*\.json"$/)
  const plan = JSON.parse(readFileSync(join(w.dataDir, 'recipes', 'plans', `${r.ids.setup}.json`), 'utf8'))
  expect(plan).toMatchObject({ file: 'npm', args: ['install'], cwd: (w.node(r.group) as GroupNode).worktree!.path })
  expect(plan.note).toContain('Setup step 1 of 1 from recipe "Implement and review" (built-in)')
})

test('a failed setup step keeps the agents from starting; success starts the implementer, then the reviewer after it', async () => {
  const w = recipeWorld()
  const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params() })
  if (!r.ok) throw new Error(r.reason)
  w.runner.exit(r.ids.setup, 1)
  expect(w.runner.started).toEqual([r.ids.setup])
  expect(w.agent(r.ids.implementer).setupWait?.failed).toMatchObject({ exitCode: 1, why: 'exit' })
  w.runner.exit(r.ids.setup, 0)
  expect(w.runner.started).toEqual([r.ids.setup, r.ids.implementer])
  expect(w.tracker.get(r.ids.reviewer)).toBe('queued')
  expect(w.agent(r.ids.reviewer).after).toEqual([r.ids.implementer])
})

test('starting the same recipe twice makes distinct nodes, sessions and worktrees', async () => {
  const w = recipeWorld()
  const a = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ branch: 'one' }) })
  const b = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ branch: 'two' }) })
  if (!a.ok || !b.ok) throw new Error('start failed')
  const aIds = Object.values(a.ids)
  expect(Object.values(b.ids).some((id) => aIds.includes(id))).toBe(false)
  expect(a.group).not.toBe(b.group)
  expect(w.worktrees.map((x) => x.branch)).toEqual(['one', 'two'])
  const agents = w.store.get().nodes.filter((n): n is ClaudeNode => n.kind === 'claude')
  expect(agents).toHaveLength(4)
  expect(new Set(agents.map((n) => n.cwd)).size).toBe(2)
  expect(agents.every((n) => n.sessionId === null)).toBe(true)
  // A third start on a branch already used is refused before anything is added.
  const count = w.store.get().nodes.length
  const c = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ branch: 'one' }) })
  expect(c).toMatchObject({ ok: false, reason: expect.stringMatching(/already exists/) })
  expect(w.store.get().nodes.length).toBe(count)
})

test('without a worktree it works in the chosen folder, and needs one', async () => {
  const w = recipeWorld()
  expect(await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ worktree: false, cwd: '' }) })).toMatchObject({ ok: false })
  const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ worktree: false, cwd: process.cwd(), skip: ['setup'] }) })
  if (!r.ok) throw new Error(r.reason)
  expect(w.worktrees).toEqual([])
  expect(r.worktree).toBeNull()
  expect(w.agent(r.ids.implementer).cwd).toBe(process.cwd())
  // With the setup step left out, the implementer starts at once and the reviewer waits for it.
  expect(w.runner.started).toEqual([r.ids.implementer])
  expect(w.agent(r.ids.reviewer).after).toEqual([r.ids.implementer])
})

test('an agent that runs a recipe opens its nodes and is linked to its agents', async () => {
  const w = recipeWorld([{ id: 'lead', kind: 'claude', title: 'Lead', x: 0, y: 0, width: 600, height: 400, parentId: null, projectId: 'p1', cwd: process.cwd(), sessionId: null, transcriptPath: null, after: [] }])
  const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params(), openedBy: 'lead' })
  if (!r.ok) throw new Error(r.reason)
  expect(w.node(r.group)?.openedBy).toBe('lead')
  const edges = w.store.get().edges
  expect(edges.some((e) => e.kind === 'link' && e.from === 'lead' && e.to === r.ids.reviewer)).toBe(true)
  expect(w.node(r.group)!.x).toBeGreaterThanOrEqual(640)
})

test('repository and personal recipes are listed with their source, in precedence order, and a bad file says why', () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-recipe-src-'))
  const personal = join(root, 'personal')
  const repo = join(root, 'repo')
  mkdirSync(personal, { recursive: true })
  mkdirSync(join(repo, '.patchbay', 'recipes'), { recursive: true })
  const recipe = (name: string) => JSON.stringify({ schema: 1, name, nodes: [{ key: 'a', kind: 'agent', layout: { x: 0, y: 0, width: 600, height: 400 } }] })
  writeFileSync(join(personal, 'mine.json'), recipe('Implement and review'))
  writeFileSync(join(repo, '.patchbay', 'recipes', 'team.json'), recipe('Implement and review'))
  writeFileSync(join(repo, '.patchbay', 'recipes', 'broken.json'), '{"schema": 1, "name": "Broken", "nodes": []}')
  const entries = listRecipes(personal, repo)
  expect(entries.map((e) => [e.source, e.name])).toEqual([
    ['repository', 'broken'],
    ['repository', 'Implement and review'],
    ['personal', 'Implement and review'],
    ['built-in', 'Implement and review']
  ])
  expect(entries[0].problem).toMatch(/no nodes/)
  expect(entries[1].file).toBe(join(repo, '.patchbay', 'recipes', 'team.json'))
  const byName = findRecipe(entries, 'implement and review')
  expect(byName.ok && byName.entry.source).toBe('repository')
  const explicit = findRecipe(entries, 'personal:Implement and review')
  expect(explicit.ok && explicit.entry.source).toBe('personal')
  expect(findRecipe(entries, 'Broken')).toMatchObject({ ok: false, problem: expect.stringMatching(/can't be used/) })
})

test('saving writes a personal recipe file, and won\'t replace one unless asked', async () => {
  const w = recipeWorld()
  const recipe = (await w.service.list('p1')).entries[0].recipe!
  const first = await w.service.save({ projectId: 'p1', recipe: { ...recipe, name: 'My setup' }, where: 'personal' })
  expect(first).toMatchObject({ ok: true })
  expect(readdirSync(join(w.dataDir, 'recipes'))).toContain('my-setup.json')
  expect(await w.service.save({ projectId: 'p1', recipe: { ...recipe, name: 'My setup' }, where: 'personal' })).toMatchObject({ ok: false, exists: true })
  expect(await w.service.save({ projectId: 'p1', recipe: { ...recipe, name: 'My setup' }, where: 'personal', overwrite: true })).toMatchObject({ ok: true })
  const listed = (await w.service.list('p1')).entries.find((e) => e.source === 'personal')
  expect(listed?.name).toBe('My setup')
})

test('a spot asked for is kept when free, and moved clear when a node is there', async () => {
  const w = recipeWorld([{ id: 'there', kind: 'sticky', title: 'Note', text: '', x: 0, y: 0, width: 280, height: 220, parentId: null, projectId: 'p1' }])
  const p = params({ worktree: false, cwd: process.cwd(), skip: ['setup'] })
  const free = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: p, at: { x: 3000, y: 3000 } })
  if (!free.ok) throw new Error(free.reason)
  expect(w.node(free.group)).toMatchObject({ x: 3000, y: 3000 })
  const onNote = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: p, at: { x: 10, y: 10 } })
  if (!onNote.ok) throw new Error(onNote.reason)
  const g = w.node(onNote.group)!
  const note = w.node('there')!
  expect(g.x >= note.x + note.width || g.y >= note.y + note.height || g.x + g.width <= note.x || g.y + g.height <= note.y).toBe(true)
})
