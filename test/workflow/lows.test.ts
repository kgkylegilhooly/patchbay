import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTaskService } from '../../src/main/tasks/service'
import { planPrune, DEFAULT_PRUNE } from '../../src/core/workflow/prune'
import { createRun } from '../../src/core/workflow/engine'
import type { TaskRevision } from '../../src/shared/task'
import type { WorkflowRun } from '../../src/shared/workflow'
import { claudeNode, memoryStore } from '../control/fakes'
import { featureWorkflow } from './fixtures'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pb-wf-lows-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rev: TaskRevision = { revision: 'abc', fingerprint: 'f1', uncommitted: false }

describe('L1: a task check run by its workflow step is recorded, not run again', () => {
  const setup = () => {
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const store = memoryStore([claudeNode('agent', { projectId: 'p', cwd: repo })])
    store.dispatch({ op: 'addProject', project: { id: 'p', name: 'P', folder: repo, viewport: { x: 0, y: 0, zoom: 1 } } })
    let ran = 0
    const tasks = createTaskService(store, dir, async () => {}, async () => rev, async (a) => (ran++, { ...a, status: 'passed', exitCode: 0, endedAt: 1, endRevision: rev }))
    return { repo, tasks, ran: () => ran }
  }

  test('the run of exactly the declared check counts as its evidence, with no second run', async () => {
    const { repo, tasks, ran } = setup()
    const task = await tasks.create('p', { brief: 'B', acceptanceCriteria: ['Works'], assignedSessionIds: [], cwd: repo, requiredChecks: [{ id: 'tests', command: 'npm test --', cwd: repo }], dependsOn: [] })
    const log = join(dir, 'log.txt')
    writeFileSync(log, 'all passing')
    const a = await tasks.recordRun('p', task.id, 'agent', { checkId: 'tests', command: 'npm test --', cwd: repo, startedAt: 1, endedAt: 2, exitCode: 0, revision: rev, endRevision: rev, outputRef: log })
    expect(a).toMatchObject({ kind: 'command', status: 'passed', exitCode: 0, outputRef: log })
    expect(ran()).toBe(0)
    await tasks.submit('p', task.id, 'agent', 'Done')
    expect((await tasks.show('p', task.id)).readiness).toMatchObject({ ready: true })
  })

  test('a run of anything but the declared command or folder is refused', async () => {
    const { repo, tasks } = setup()
    const task = await tasks.create('p', { brief: 'B', acceptanceCriteria: ['Works'], assignedSessionIds: [], cwd: repo, requiredChecks: [{ id: 'tests', command: 'npm test --', cwd: repo }], dependsOn: [] })
    const run = { checkId: 'tests', command: 'npm test --', cwd: repo, startedAt: 1, endedAt: 2, exitCode: 0, revision: rev, endRevision: rev, outputRef: 'x' }
    await expect(tasks.recordRun('p', task.id, 'agent', { ...run, command: 'npm test -- --other' })).rejects.toThrow(/must match/)
    await expect(tasks.recordRun('p', task.id, 'agent', { ...run, cwd: dir })).rejects.toThrow(/must match/)
    await expect(tasks.recordRun('p', task.id, 'agent', { ...run, checkId: 'lint' })).rejects.toThrow(/no check/)
  })
})

describe('L2: pruning', () => {
  const day = 24 * 60 * 60_000
  const run = (id: string, state: WorkflowRun['state'], endedDaysAgo: number | null, taskId?: string): WorkflowRun => {
    const r = createRun({ workflow: featureWorkflow(), hash: 'h', ref: 'r', id, projectId: 'p', inputs: { brief: 'x' }, cwd: 'C:\\wt', worktree: null, groupId: null, ...(taskId ? { taskId } : {}) }, { now: 0, newId: () => 'n' })
    if (!r.ok) throw new Error('bad')
    return { ...r.run, state, ...(endedDaysAgo === null ? {} : { endedAt: 1000 * day - endedDaysAgo * day }) }
  }
  const now = 1000 * day

  test('finished runs past the age limit go; open ones and ones whose task is in play stay', () => {
    const runs = [
      { run: run('old-done', 'succeeded', 100), bytes: 10 },
      { run: run('old-stopped', 'stopped', 200), bytes: 10 },
      { run: run('old-failed', 'failed', null), bytes: 10 },
      { run: run('old-waiting', 'waiting-for-you', null), bytes: 10 },
      { run: run('old-task', 'succeeded', 100, 't1'), bytes: 10 },
      { run: run('recent', 'succeeded', 5), bytes: 10 }
    ]
    expect(planPrune(runs, now, DEFAULT_PRUNE, (r) => r.taskId === 't1')).toEqual(['old-done', 'old-stopped'])
  })

  test('past the size limit, the oldest finished go first, until the rest fits', () => {
    const runs = [
      { run: run('a', 'succeeded', 3), bytes: 60 },
      { run: run('b', 'succeeded', 2), bytes: 60 },
      { run: run('c', 'succeeded', 1), bytes: 60 },
      { run: run('open', 'running', null), bytes: 500 }
    ]
    expect(planPrune(runs, now, { maxAgeMs: 90 * day, maxBytes: 600 }, () => false)).toEqual(['a', 'b'])
    // Open runs never go, even when they alone are over the limit.
    expect(planPrune(runs, now, { maxAgeMs: 90 * day, maxBytes: 100 }, () => false)).toEqual(['a', 'b', 'c'])
  })
})
