import { expect, test } from 'vitest'
import { planRecipe, type RecipeParams } from '../../src/shared/recipe'
import { BUILT_IN_RECIPES } from '../../src/shared/recipeBuiltins'
import type { ClaudeNode, StickyNode } from '../../src/shared/model'

const recipe = BUILT_IN_RECIPES[0]
const params: RecipeParams = { task: 'Add dark mode', branch: 'dark-mode', repo: 'C:\\Code\\app', cwd: 'C:\\Code\\app-worktrees\\dark-mode', worktree: true }
const counter = () => {
  let n = 0
  return () => `id-${++n}`
}

test('every recipe node gets a new id, and prompts and notes name the new nodes', () => {
  const plan = planRecipe(recipe, params, counter())
  const impl = plan.nodes.find((n) => n.id === plan.ids.implementer) as ClaudeNode
  const reviewer = plan.nodes.find((n) => n.id === plan.ids.reviewer) as ClaudeNode
  const brief = plan.nodes.find((n) => n.id === plan.ids.brief) as StickyNode
  expect(impl.prompt).toContain(`patchbay send --node ${plan.ids.reviewer}`)
  expect(reviewer.prompt).toContain(`patchbay read --node ${plan.ids.implementer}`)
  expect(reviewer.prompt).toContain('Add dark mode')
  expect(brief.text).toContain('# Add dark mode')
  // The built-in brief is for the person, so it names the agents without their ids (UX audit #17).
  expect(brief.text).toContain('- Reviewer: Codex, starts after')
  expect(JSON.stringify(plan.nodes)).not.toContain('{{')
  // A note of one's own can still name a node by id.
  const own = { ...recipe, nodes: recipe.nodes.map((n) => (n.key === 'brief' ? { ...n, text: 'Reviewer: {{node:reviewer}}' } : n)) }
  const ownPlan = planRecipe(own, params, counter())
  expect((ownPlan.nodes.find((n) => n.id === ownPlan.ids.brief) as StickyNode).text).toBe(`Reviewer: ${ownPlan.ids.reviewer}`)
})

test('connections join the new nodes', () => {
  const plan = planRecipe(recipe, params, counter())
  const links = plan.edges.filter((e) => e.kind === 'link').map((e) => [e.from, e.to])
  expect(links).toContainEqual([plan.ids.implementer, plan.ids.reviewer])
  expect(plan.edges.filter((e) => e.kind === 'after').map((e) => [e.from, e.to])).toEqual([[plan.ids.implementer, plan.ids.reviewer]])
  const ids = new Set([plan.frame.id, ...plan.nodes.map((n) => n.id)])
  for (const e of plan.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true)
})

test('two plans of one recipe share no node', () => {
  const ids = (() => {
    let n = 0
    return () => `u-${++n}`
  })()
  const a = planRecipe(recipe, params, ids)
  const b = planRecipe(recipe, params, ids)
  const aIds = new Set([a.frame.id, ...a.nodes.map((n) => n.id)])
  expect([b.frame.id, ...b.nodes.map((n) => n.id)].some((id) => aIds.has(id))).toBe(false)
})

test('agents wait for setup, the reviewer then for the implementer, and nothing has a session', () => {
  const plan = planRecipe(recipe, params, counter())
  const setup = plan.setup.map((s) => s.id)
  expect(setup).toHaveLength(1)
  expect(plan.holds[plan.ids.implementer]).toEqual({ steps: setup, after: [] })
  expect(plan.holds[plan.ids.reviewer]).toEqual({ steps: setup, after: [plan.ids.implementer] })
  expect(plan.starts).toEqual([])
  for (const n of plan.nodes) if (n.kind === 'claude') expect([n.sessionId, n.transcriptPath, n.after]).toEqual([null, null, []])
  expect(plan.setup[0]).toMatchObject({ argv: ['npm', 'install'], cwd: params.cwd })
  expect(plan.runs).toEqual([{ title: 'Setup: install dependencies', what: 'npm install', how: 'no shell', cwd: params.cwd }])
})

test('a skipped setup step leaves the agents nothing to wait for but each other', () => {
  const plan = planRecipe(recipe, { ...params, skip: ['setup'] }, counter())
  expect(plan.setup).toEqual([])
  expect(plan.holds).toEqual({})
  expect(plan.starts).toEqual([plan.ids.implementer])
  expect(plan.after).toEqual({ [plan.ids.reviewer]: [plan.ids.implementer] })
})

test('changed setup arguments apply to that start only', () => {
  const plan = planRecipe(recipe, { ...params, runs: { setup: ['npm', 'ci'] } }, counter())
  expect(plan.setup[0].argv).toEqual(['npm', 'ci'])
  expect(recipe.nodes.find((n) => n.key === 'setup')).toMatchObject({ run: ['npm', 'install'] })
})

test('without a worktree, agents in one checkout get a warning that claims no isolation or locking', () => {
  expect(planRecipe(recipe, params, counter()).warnings).toEqual([])
  const shared = planRecipe(recipe, { ...params, worktree: false, cwd: 'C:\\Code\\app' }, counter())
  expect(shared.warnings).toHaveLength(1)
  const [warning] = shared.warnings
  expect(warning).toMatch(/share one checkout/)
  expect(warning).toMatch(/does not isolate or lock/)
  expect(warning).not.toMatch(/(?<!not )(isolates|locks|protects)/)
})

test('everything sits inside the frame, which is large enough to hold it', () => {
  const plan = planRecipe(recipe, params, counter())
  for (const n of plan.nodes) {
    expect(n.parentId).toBe(plan.frame.id)
    expect(n.x + n.width).toBeLessThanOrEqual(plan.frame.width)
    expect(n.y + n.height).toBeLessThanOrEqual(plan.frame.height)
  }
  expect(plan.frame.title).toBe('Implement and review: Add dark mode')
})
