import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findWorkflow, listWorkflows, REPO_WORKFLOWS, saveWorkflowFile, workflowHash } from '../../src/main/workflows/files'
import { createRunStore } from '../../src/main/workflows/store'
import { recipeHash } from '../../src/main/recipes/files'
import { createRun } from '../../src/core/workflow/engine'
import type { WorkflowRun } from '../../src/shared/workflow'
import { featureWorkflow } from './fixtures'

let dir: string
let logs: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-wf-'))
  logs = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const personal = () => join(dir, 'workflows')
const repo = () => join(dir, 'repo')
const put = (folder: string, name: string, content: unknown) => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, name), typeof content === 'string' ? content : JSON.stringify(content))
}

describe('the workflow library', () => {
  test('repository, then personal, each labelled; damaged and unfinished files listed with why', () => {
    put(personal(), 'feature.json', featureWorkflow())
    put(personal(), 'broken.json', '{ nope')
    put(personal(), 'draft.json', { schema: 1, name: 'Draft', steps: [] })
    put(join(repo(), REPO_WORKFLOWS), 'feature.json', featureWorkflow())
    const entries = listWorkflows(personal(), repo())
    expect(entries.map((e) => [e.ref, e.source, e.problem ? 'problem' : 'ok'])).toEqual([
      ['repository:Feature', 'repository', 'ok'],
      ['personal:broken.json', 'personal', 'problem'],
      ['personal:Draft', 'personal', 'problem'],
      ['personal:Feature', 'personal', 'ok']
    ])
    expect(entries[2].problem).toBe('The workflow has no steps yet. Add a step.')
    expect(entries[2].workflow).toBeDefined() // Readable, so the editor can open it.
  })

  test('the hash follows the recipe rule and names the content', () => {
    const wf = featureWorkflow()
    expect(workflowHash(wf)).toBe(recipeHash(wf))
    expect(workflowHash({ ...wf, name: 'Other' })).not.toBe(workflowHash(wf))
  })

  test('finding: precedence, case, and refusal of ones that can\'t start', () => {
    put(personal(), 'feature.json', featureWorkflow())
    put(join(repo(), REPO_WORKFLOWS), 'feature.json', featureWorkflow())
    put(personal(), 'draft.json', { schema: 1, name: 'Draft', steps: [] })
    const entries = listWorkflows(personal(), repo())
    expect(findWorkflow(entries, 'feature')).toMatchObject({ ok: true, entry: { source: 'repository' } })
    expect(findWorkflow(entries, 'personal:FEATURE')).toMatchObject({ ok: true, entry: { source: 'personal' } })
    expect(findWorkflow(entries, 'Draft')).toEqual({ ok: false, problem: 'The workflow "Draft" can\'t be started: The workflow has no steps yet. Add a step.' })
    expect(findWorkflow(entries, 'nope')).toMatchObject({ ok: false })
  })

  test('saving keeps work in progress, refuses what can\'t be represented, and won\'t replace a file unasked', async () => {
    const draft = await saveWorkflowFile(personal(), { schema: 1, name: 'Draft', steps: [] }, { overwrite: false })
    expect(draft).toMatchObject({ ok: true, issues: [{ message: 'The workflow has no steps yet. Add a step.' }] })
    expect(await saveWorkflowFile(personal(), { schema: 1, name: 'Draft', steps: [] }, { overwrite: false })).toMatchObject({ ok: false, exists: true })
    expect(await saveWorkflowFile(personal(), { schema: 1, name: 'X', steps: [], cron: 'daily' }, { overwrite: true })).toMatchObject({ ok: false, reason: expect.stringContaining('"cron"') })
    expect(readdirSync(personal())).toEqual(['draft.json'])
  })
})

function aRun(id = 'r1'): WorkflowRun {
  let n = 0
  const r = createRun({ workflow: featureWorkflow(), hash: 'h', ref: 'personal:Feature', id, projectId: 'p', inputs: { brief: 'x' }, cwd: 'C:\\wt', worktree: null, groupId: 'g' }, { now: 1, newId: () => `n${++n}` })
  if (!r.ok) throw new Error('bad run')
  return r.run
}

describe('the run store', () => {
  const store = () => createRunStore(dir, { now: () => 42, log: (l) => logs.push(l) })

  test('a run saves and loads back the same, apart from the canvas document', async () => {
    const s = store()
    await s.save(aRun())
    expect(store().load()).toEqual({ runs: [aRun()], unavailable: [] })
    expect(readdirSync(dir).sort()).toEqual(['runs'])
  })

  test('writes to one run happen in order, and the last one wins', async () => {
    const s = store()
    const run = aRun()
    await Promise.all([s.save({ ...run, state: 'failed' }), s.save({ ...run, state: 'needs-attention' }), s.save({ ...run, state: 'stopped', stopped: true })])
    expect(store().load().runs[0].state).toBe('stopped')
    expect(readdirSync(join(dir, 'runs'))).toEqual(['r1.json'])
  })

  test('damaged run files are moved aside without stopping the rest; a newer one is left alone', async () => {
    const s = store()
    await s.save(aRun('good'))
    put(join(dir, 'runs'), 'broken.json', '{')
    put(join(dir, 'runs'), 'wrong.json', { ...aRun('wrong'), attempts: [{ id: 1 }] })
    put(join(dir, 'runs'), 'newer.json', { schema: 2, id: 'newer' })
    const loaded = store().load()
    expect(loaded.runs.map((r) => r.id)).toEqual(['good'])
    expect(loaded.unavailable.map((u) => [u.file.split(/[\\/]/).pop(), !!u.setAside])).toEqual([['broken.json', true], ['newer.json', false], ['wrong.json', true]])
    expect(readdirSync(join(dir, 'runs')).sort()).toEqual(['broken.json.bad-42', 'good.json', 'newer.json', 'wrong.json.bad-42'])
    expect(logs).toHaveLength(2)
  })

  test('trusted hashes persist', async () => {
    const s = store()
    expect(s.isTrusted('h1')).toBe(false)
    await s.trust('h1')
    expect(store().isTrusted('h1')).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'trusted.json'), 'utf8'))).toEqual({ hashes: ['h1'] })
  })

  test('a damaged trusted list trusts nothing and says so', () => {
    put(dir, 'trusted.json', '{')
    expect(store().isTrusted('h1')).toBe(false)
    expect(logs[0]).toMatch(/trusted list couldn't be read/)
  })
})
