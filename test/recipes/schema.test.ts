import { describe, expect, test } from 'vitest'
import type { CanvasNode, Edge } from '../../src/shared/model'
import { fillIn, folderIn, readRecipe, recipeFromSelection, relativeFolder, RecipeError, toArgv, expectedWorktreePath, type Recipe } from '../../src/shared/recipe'
import { BUILT_IN_RECIPES } from '../../src/shared/recipeBuiltins'
import { defaultWorktreePath } from '../../src/core/worktree/service'

const at = { x: 0, y: 0, width: 300, height: 200 }

const minimal = (over: Record<string, unknown> = {}) => ({ schema: 1, name: 'R', nodes: [{ key: 'a', kind: 'agent', title: 'A', layout: at }], ...over })

describe('reading a recipe', () => {
  test('keeps only the fields it knows, so nothing live can come in with a file', () => {
    const r = readRecipe(minimal({ nodes: [{ key: 'a', kind: 'agent', title: 'A', layout: at, sessionId: 'abc', transcriptPath: 'C:\\t.jsonl', token: 'secret' }], projectId: 'p1' }))
    const text = JSON.stringify(r)
    expect(text).not.toMatch(/sessionId|transcriptPath|secret|projectId/)
    expect(r.nodes[0]).toMatchObject({ key: 'a', kind: 'agent', agent: 'claude' })
  })

  test('refuses an unknown schema, a reference to a missing node, and starts-after that loops', () => {
    expect(() => readRecipe(minimal({ schema: 2 }))).toThrow(/schema/)
    expect(() => readRecipe(minimal({ links: [{ from: 'a', to: 'b' }] }))).toThrow(RecipeError)
    expect(() => readRecipe(minimal({ nodes: [{ key: 'a', kind: 'agent', title: 'A', layout: at, prompt: 'see {{node:zz}}' }] }))).toThrow(/zz/)
    expect(() =>
      readRecipe(
        minimal({
          nodes: [
            { key: 'a', kind: 'agent', layout: at, after: ['b'] },
            { key: 'b', kind: 'agent', layout: at, after: ['a'] }
          ]
        })
      )
    ).toThrow(/waiting on itself/)
  })

  test('a setup step must be an argument list, never a shell string', () => {
    expect(() => readRecipe(minimal({ nodes: [{ key: 's', kind: 'setup', layout: at, run: 'npm install' }] }))).toThrow(/list/)
    expect(readRecipe(minimal({ nodes: [{ key: 's', kind: 'setup', layout: at, run: ['npm', 'install'] }] })).nodes[0]).toMatchObject({ run: ['npm', 'install'] })
  })

  test('the built-in recipe has a Claude implementer, a Codex reviewer after it, a setup step and a brief', () => {
    const r = BUILT_IN_RECIPES.find((b) => b.name === 'Implement and review')!
    const kinds = r.nodes.map((n) => (n.kind === 'agent' ? `${n.kind}:${n.agent}` : n.kind))
    expect(kinds).toEqual(expect.arrayContaining(['agent:claude', 'agent:codex', 'setup', 'run', 'note']))
    const reviewer = r.nodes.find((n) => n.key === 'reviewer')
    expect(reviewer).toMatchObject({ agent: 'codex', after: ['implementer'] })
    expect(r.worktree).toBe(true)
  })
})

describe('parameters', () => {
  test('fills in task, branch, repo, cwd and node ids, and leaves anything else', () => {
    const out = fillIn('{{task}} on {{branch}} in {{cwd}} from {{repo}}, ask {{node:x}}, keep {{other}}', { task: 'T', branch: 'b', repo: 'R', cwd: 'C' }, { x: 'id-1' })
    expect(out).toBe('T on b in C from R, ask id-1, keep {{other}}')
  })

  test('folders resolve against the working directory unless absolute', () => {
    expect(folderIn('C:\\wt\\feat', undefined)).toBe('C:\\wt\\feat')
    expect(folderIn('C:\\wt\\feat', 'web/app')).toBe('C:\\wt\\feat\\web\\app')
    expect(folderIn('C:\\wt\\feat', 'D:\\other')).toBe('D:\\other')
    expect(relativeFolder('C:\\Code\\repo', 'C:\\code\\repo\\web')).toBe('web')
    expect(relativeFolder('C:\\Code\\repo', 'C:\\Code\\repo')).toBeUndefined()
    expect(relativeFolder('C:\\Code\\repo', 'D:\\x')).toBe('D:\\x')
  })

  test('the expected worktree folder is the one the worktree service makes', () => {
    expect(expectedWorktreePath('C:\\Code\\repo', 'feat/x')).toBe(defaultWorktreePath('C:\\Code\\repo', 'feat/x'))
  })

  test('a command splits into arguments only when no shell would read it differently', () => {
    expect(toArgv('npm  run build')).toEqual(['npm', 'run', 'build'])
    expect(toArgv('npm ci && npm test')).toBeNull()
    expect(toArgv('echo "a b"')).toBeNull()
    expect(toArgv('dir C:\\x')).toBeNull()
    // With no shell to run it, a Windows path is just an argument.
    expect(toArgv('node C:\\x\\a.js {{task}}', true)).toEqual(['node', 'C:\\x\\a.js', '{{task}}'])
    expect(toArgv('a | b', true)).toBeNull()
  })
})

describe('saving a selection', () => {
  const wt = 'C:\\Code\\repo-worktrees\\feat-x'
  const nodes: CanvasNode[] = [
    { id: 'g', kind: 'group', title: 'Feature', x: 100, y: 100, width: 1400, height: 900, parentId: null, worktree: { path: wt, branch: 'feat-x', repo: 'C:\\Code\\repo' }, projectId: 'p1' },
    { id: 'impl-id', kind: 'claude', title: 'Implementer', x: 24, y: 64, width: 620, height: 420, parentId: 'g', cwd: wt, prompt: `Work on feat-x in ${wt}; reviewer is review-id`, sessionId: 'sess-1', transcriptPath: 'C:\\t\\1.jsonl', after: [], openedBy: 'lead', projectId: 'p1' },
    { id: 'review-id', kind: 'claude', agent: 'codex', title: 'Reviewer', x: 700, y: 64, width: 620, height: 420, parentId: 'g', cwd: `${wt}\\web`, sessionId: 'sess-2', transcriptPath: null, after: [], projectId: 'p1' },
    { id: 'run-id', kind: 'run', title: 'Install', x: 24, y: 500, width: 560, height: 300, parentId: 'g', cwd: wt, command: 'npm install', projectId: 'p1' },
    { id: 'shell-id', kind: 'run', title: 'Build', x: 600, y: 500, width: 560, height: 300, parentId: 'g', cwd: wt, command: 'npm ci && npm run build', projectId: 'p1' },
    { id: 'trig', kind: 'trigger', title: 'Nightly', x: 0, y: 0, width: 300, height: 300, parentId: 'g', schedule: { type: 'interval', everyMs: 1000 }, prompt: 'x', targetId: null, armedSpec: null, armedAt: null, nextAt: null, runs: [] }
  ]
  const edges: Edge[] = [
    { id: 'e1', from: 'impl-id', to: 'review-id', kind: 'after' },
    { id: 'e2', from: 'impl-id', to: 'review-id', kind: 'link' },
    { id: 'e3', from: 'review-id', to: 'impl-id', kind: 'link' },
    { id: 'e4', from: 'lead', to: 'impl-id', kind: 'opened' }
  ]
  const save = () => recipeFromSelection(nodes, edges, ['g'], { name: 'Mine', cwd: wt, branch: 'feat-x', setupIds: ['run-id', 'shell-id'] })

  test('saves configuration, never sessions, ids or who opened what', () => {
    const { recipe } = save()
    const text = JSON.stringify(recipe)
    for (const live of ['sess-1', 'sess-2', '1.jsonl', 'impl-id', 'review-id', 'lead', 'p1', 'openedBy', 'sessionId']) expect(text).not.toContain(live)
  })

  test('a selected worktree group becomes the frame, and its folder and branch become parameters', () => {
    const { recipe } = save()
    expect(recipe.worktree).toBe(true)
    expect(recipe.frame).toMatchObject({ width: 1400, height: 900 })
    const impl = recipe.nodes.find((n) => n.title === 'Implementer')!
    expect(impl).toMatchObject({ kind: 'agent', layout: { x: 24, y: 64 } })
    expect(impl.kind === 'agent' && impl.prompt).toBe('Work on {{branch}} in {{cwd}}; reviewer is {{node:reviewer}}')
    expect(recipe.nodes.find((n) => n.title === 'Reviewer')).toMatchObject({ agent: 'codex', folder: 'web', after: ['implementer'] })
  })

  test('connections are kept once each, and a trigger is left out with the reason', () => {
    const { recipe, skipped } = save()
    expect(recipe.links).toEqual([{ from: 'implementer', to: 'reviewer' }])
    expect(skipped.map((s) => s.title)).toEqual(['Nightly'])
  })

  test('a plain command can be a setup step; one using shell syntax stays a run command and says why', () => {
    const { recipe, notSetup } = save()
    expect(recipe.nodes.find((n) => n.title === 'Install')).toMatchObject({ kind: 'setup', run: ['npm', 'install'] })
    expect(recipe.nodes.find((n) => n.title === 'Build')).toMatchObject({ kind: 'run', command: 'npm ci && npm run build' })
    expect(notSetup.map((n) => n.title)).toEqual(['Build'])
  })

  test('what is saved reads back as a valid recipe', () => {
    const { recipe } = save()
    const again: Recipe = readRecipe(JSON.parse(JSON.stringify(recipe)))
    expect(again).toEqual(recipe)
  })
})
