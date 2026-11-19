import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { startControlServer, tokenFor } from '../../src/main/control/server'
import { withRecipeVerbs } from '../../src/main/recipes/verbs'
import { cleanEnv } from '../../src/main/sessions/env'
import type { ClaudeNode } from '../../src/shared/model'
import { recipeWorld } from './fakes'

const lead: ClaudeNode = { id: 'lead', kind: 'claude', title: 'Lead', x: 0, y: 0, width: 600, height: 400, parentId: null, projectId: 'p1', cwd: process.cwd(), sessionId: null, transcriptPath: null, after: [] }

function world() {
  const w = recipeWorld([lead])
  const passed: string[] = []
  const verbs = withRecipeVerbs(async (_caller, verb) => (passed.push(verb), { ok: true }), { store: w.store, service: w.service })
  return { ...w, verbs, passed }
}

test('other verbs pass straight through', async () => {
  const w = world()
  await w.verbs('lead', 'list', {})
  expect(w.passed).toEqual(['list'])
})

test('recipes lists every recipe with its source, and previews one without running anything', async () => {
  const w = world()
  const listed = (await w.verbs('lead', 'recipes', {})) as { recipes: Array<{ name: string; source: string }> }
  expect(listed.recipes).toContainEqual(expect.objectContaining({ name: 'Implement and review', source: 'built-in' }))
  const shown = (await w.verbs('lead', 'recipes', { name: 'Implement and review', task: 'Add dark mode' })) as { worktree: { branch: string }; runsOnStart: Array<{ what: string }>; nodes: Array<{ key: string; startsAfter?: string[] }> }
  expect(shown.worktree.branch).toBe('add-dark-mode')
  expect(shown.runsOnStart.map((r) => r.what)).toEqual(['npm install'])
  expect(shown.nodes.find((n) => n.key === 'reviewer')?.startsAfter).toEqual(['implementer'])
  expect(w.runner.started).toEqual([])
  expect(w.worktrees).toEqual([])
  expect(w.store.get().nodes).toHaveLength(1)
})

test('run-recipe makes the nodes for the caller, opened by it', async () => {
  const w = world()
  const r = (await w.verbs('lead', 'run-recipe', { name: 'Implement and review', task: 'Add dark mode', branch: 'dm' })) as { group: string; nodes: Record<string, string> }
  expect(w.worktrees.map((x) => x.branch)).toEqual(['dm'])
  expect(w.node(r.group)?.openedBy).toBe('lead')
  expect(w.runner.started).toEqual([r.nodes.setup])
})

test('run-recipe refuses what it cannot do, before changing anything', async () => {
  const w = world()
  await expect(w.verbs('lead', 'run-recipe', {})).rejects.toThrow(/--name/)
  await expect(w.verbs('lead', 'run-recipe', { name: 'Nope' })).rejects.toThrow(/no recipe called "Nope"/)
  await expect(w.verbs('lead', 'run-recipe', { name: 'Implement and review', source: 'web' })).rejects.toThrow(/--source/)
  await expect(w.verbs('lead', 'run-recipe', { name: 'Implement and review' })).rejects.toThrow(/branch/)
  expect(w.store.get().nodes).toHaveLength(1)
})

test('the patchbay command passes the recipe flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-recipe-cli-'))
  const calls: Array<{ verb: string; args: Record<string, unknown> }> = []
  const server = await startControlServer({ secret: 's', endpointFile: join(dir, 'endpoint.json'), onHook: () => ({}), onRpc: async (_c, verb, args) => (calls.push({ verb, args }), {}) })
  try {
    const env = cleanEnv(process.env, { PATCHBAY_NODE_ID: 'n', PATCHBAY_TOKEN: tokenFor('s', 'n'), PATCHBAY_ENDPOINT_FILE: join(dir, 'endpoint.json') })
    const code = await new Promise<number>((done) =>
      execFile(process.execPath, [resolve('resources/cli/patchbay.cjs'), 'run-recipe', '--name', 'Implement and review', '--task', 'T', '--no-worktree', '--skip', 'setup,other'], { env, cwd: dir, windowsHide: true }, (e) => done(e ? 1 : 0))
    )
    expect(code).toBe(0)
    expect(calls).toEqual([{ verb: 'run-recipe', args: { name: 'Implement and review', task: 'T', noWorktree: true, skip: ['setup', 'other'] } }])
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
