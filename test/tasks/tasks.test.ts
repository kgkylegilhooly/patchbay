import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createTaskService } from '../../src/main/tasks/service'
import { executeVerification, readRevision } from '../../src/main/tasks/verification'
import { taskVerb } from '../../src/main/tasks/verbs'
import { createDocStore, migrate } from '../../src/core/persist/docStore'
import { createAppStore } from '../../src/main/appStore'
import { createAfterGate } from '../../src/main/control/after'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createVerbs } from '../../src/main/control/verbs'
import { emptyTasks, taskReadiness, type Task, type TaskRecords, type TaskRevision, type TaskVerification } from '../../src/shared/task'
import { claudeNode, fakeHost, fakeRunner, memoryStore } from '../control/fakes'

let dir: string
let repo: string
const rev: TaskRevision = { revision: 'abc123', fingerprint: 'tree1', uncommitted: false }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-tasks-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
const input = () => ({ brief: 'Implement tasks', acceptanceCriteria: ['Outcomes persist'], assignedSessionIds: ['me'], cwd: repo, requiredChecks: [{ id: 'unit', command: 'echo verified', cwd: repo }], dependsOn: [] })
function setup() {
  const store = memoryStore([claudeNode('me', { projectId: 'project-1', cwd: repo })])
  store.dispatch({ op: 'addProject', project: { id: 'project-1', name: 'Test', folder: repo, viewport: { x: 0, y: 0, zoom: 1 } } })
  const tasks = createTaskService(store, dir, async () => {}, async () => rev)
  return { store, tasks }
}
async function waitForCheck(tasks: ReturnType<typeof createTaskService>, id: string): Promise<void> {
  await vi.waitFor(async () => {
    const view = await tasks.show('project-1', id)
    expect(view.attempts.filter((a) => a.kind === 'command').at(-1)).not.toMatchObject({ status: 'running' })
  }, { timeout: 5000 })
}
function readyData(): { data: TaskRecords; task: Task; check: TaskVerification } {
  const task: Task = { ...input(), id: 'task', projectId: 'project-1', createdAt: 1, updatedAt: 3, state: 'ready-for-review', submissionId: 'submission', acceptances: [] }
  const check: TaskVerification = { id: 'check', taskId: task.id, kind: 'command', sessionId: 'me', checkId: 'unit', command: 'echo verified', cwd: repo, status: 'passed', exitCode: 0, startedAt: 1, endedAt: 2, outputRef: join(dir, 'output.log'), revision: rev, endRevision: rev }
  return { task, check, data: { tasks: [task], attempts: [check, { id: 'submission', taskId: task.id, kind: 'agent-report', sessionId: 'me', summary: 'Done', startedAt: 3, endedAt: 3, revision: rev }] } }
}

test('idle agents never accept; agents submit but cannot accept via either verb or state', async () => {
  const { store, tasks } = setup()
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const verbs = createVerbs({ store, tasks, runner, tracker, gate, host: fakeHost() })
  const task = await tasks.create('project-1', { ...input(), requiredChecks: [] })
  tracker.seed('me', 'idle')
  expect(tasks.list('project-1')[0].state).toBe('planned')
  const submitted = await tasks.submit('project-1', task.id, 'me', 'Please review')
  expect(submitted.task.state).toBe('ready-for-review')
  expect(submitted.attempts[0].kind).toBe('agent-report')
  expect(submitted.task.acceptances).toEqual([])
  await expect(verbs('me', 'task-accept', { task: task.id })).rejects.toThrow(/human UI/)
  await expect(verbs('me', 'task-state', { task: task.id, state: 'accepted' })).rejects.toThrow(/person/)
  await expect(tasks.accept('project-1', task.id, 'old-submission')).rejects.toThrow(/changed/)
  const accepted = await tasks.accept('project-1', task.id, submitted.task.submissionId!)
  expect(accepted.acceptances).toEqual([{ submissionId: submitted.task.submissionId, by: 'human', at: expect.any(Number), revision: rev }])
  expect((await tasks.show('project-1', task.id)).attempts).toHaveLength(1)
})

test('missing, failed, running, dirty-changed and stale required checks block; self-reports cannot pass checks', () => {
  const { task, data, check } = readyData()
  const snapshots = { [repo]: rev }
  expect(taskReadiness(data, task, snapshots).ready).toBe(true)
  expect(taskReadiness({ ...data, attempts: data.attempts.slice(1) }, task, snapshots).ready).toBe(false)
  for (const patch of [{ status: 'failed', exitCode: 1 }, { status: 'running', exitCode: null }, { endRevision: { ...rev, uncommitted: true } }, { command: 'echo other' }]) {
    expect(taskReadiness({ ...data, attempts: [{ ...check, ...patch } as TaskVerification, data.attempts[1]] }, task, snapshots).ready).toBe(false)
  }
  expect(taskReadiness(data, task, { [repo]: { ...rev, revision: 'new' } }).ready).toBe(false)
  expect(taskReadiness(data, task, { [repo]: { ...rev, fingerprint: 'new' } }).ready).toBe(false)
  expect(taskReadiness(data, task, { [repo]: { revision: null, fingerprint: null, uncommitted: null } }).ready).toBe(false)
  expect(taskReadiness({ ...data, attempts: [...data.attempts, { ...check, id: 'retry', status: 'failed', exitCode: 2 }] }, task, snapshots).ready).toBe(false)
})

test('missing or cancelled upstream task never counts as success; dependency cycles fail closed', () => {
  const { data, task } = readyData()
  const dependent = { ...task, id: 'dependent', dependsOn: [task.id], requiredChecks: [], submissionId: 'dependent-submission' }
  data.attempts.push({ id: dependent.submissionId, taskId: dependent.id, kind: 'agent-report', sessionId: 'me', summary: 'Ready', startedAt: 3, endedAt: 3, revision: rev })
  const snapshots = { [repo]: rev }
  expect(taskReadiness({ ...data, tasks: [{ ...task, state: 'accepted' }, dependent] }, dependent, snapshots).ready).toBe(true)
  expect(taskReadiness({ ...data, tasks: [dependent] }, dependent, snapshots).reasons.join(' ')).toMatch(/Upstream/)
  expect(taskReadiness({ ...data, tasks: [{ ...task, state: 'cancelled' }, dependent] }, dependent, snapshots).ready).toBe(false)
  expect(taskReadiness({ ...data, tasks: [{ ...task, state: 'accepted', dependsOn: [dependent.id] }, { ...dependent, state: 'accepted' }] }, dependent, snapshots).ready).toBe(false)
})

test('a long-running command is stopped and recorded as failed, never passed', async () => {
  const { check } = readyData()
  const running = { ...check, status: 'running' as const, endedAt: null, exitCode: null, command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"` }
  const result = await executeVerification(running, 100)
  expect(result.status).toBe('failed')
  expect(result.error).toMatch(/time limit/)
  expect(readFileSync(check.outputRef, 'utf8')).toContain('time limit')
}, 10000)

test('restart preserves outcomes and attempts, marks interrupted runs, and never launches them', async () => {
  const docStore = createDocStore(dir)
  const store = createAppStore(docStore)
  const { data, check } = readyData()
  data.attempts.push({ ...check, id: 'interrupted', status: 'running', exitCode: null, endedAt: null })
  store.dispatch({ op: 'setTasks', projectId: 'project-1', tasks: data })
  await docStore.flush()
  const reloaded = createAppStore(createDocStore(dir))
  const tasks = createTaskService(reloaded, dir)
  expect(tasks.list('project-1')[0].state).toBe('blocked')
  const saved = reloaded.get().projects[0].tasks!
  expect(saved.attempts).toHaveLength(3)
  expect(saved.attempts[2]).toMatchObject({ status: 'interrupted', exitCode: null })
  expect(saved.attempts[0]).toEqual(check)
  expect(saved.tasks[0].dependsOn).toEqual(data.tasks[0].dependsOn)
  expect(createDocStore(dir).load().doc.nodes).toEqual([])
})

test('old projects have no tasks; a damaged task record is dropped on its own and the canvas still loads', () => {
  const old = createDocStore(dir).load().doc
  expect(migrate(old).projects[0].tasks).toBeUndefined()
  expect(migrate({ ...old, projects: [{ ...old.projects[0], tasks: { tasks: [{}], attempts: [] } }] }).projects[0].tasks).toEqual(emptyTasks())
  expect(migrate({ ...old, projects: [{ ...old.projects[0], tasks: emptyTasks() }] }).projects[0].tasks).toEqual(emptyTasks())
})

test('human acceptance refuses missing output and stale evidence; reopening preserves previous decisions', async () => {
  const { store, tasks } = setup()
  const { data, task, check } = readyData()
  store.dispatch({ op: 'setTasks', projectId: 'project-1', tasks: data })
  await expect(tasks.accept('project-1', task.id, task.submissionId!)).rejects.toThrow(/output is missing/)
  writeFileSync(check.outputRef, 'verified')
  const staleService = createTaskService(store, dir, async () => {}, async () => ({ ...rev, fingerprint: 'changed' }))
  await expect(staleService.accept('project-1', task.id, task.submissionId!)).rejects.toThrow(/stale/)
  const accepted = await tasks.accept('project-1', task.id, task.submissionId!)
  expect(accepted.state).toBe('accepted')
  const reopened = await tasks.state('project-1', task.id, 'running')
  expect(reopened.acceptances).toEqual(accepted.acceptances)
  expect(reopened.submissionId).toBeUndefined()
  expect((await tasks.show('project-1', task.id)).attempts).toEqual(data.attempts)
})

test('successful retry promotes a submitted blocked task without erasing its earlier failed attempt', async () => {
  const { store } = setup()
  let pass = false
  const execute = async (a: TaskVerification): Promise<TaskVerification> => ({ ...a, status: pass ? 'passed' : 'failed', exitCode: pass ? 0 : 1, endedAt: Date.now(), endRevision: rev })
  const tasks = createTaskService(store, dir, async () => {}, async () => rev, execute)
  const task = await tasks.create('project-1', input())
  await tasks.submit('project-1', task.id, 'me', 'Ready when checks pass')
  expect(tasks.list('project-1')[0].state).toBe('blocked')
  await tasks.verify('project-1', task.id, 'me', 'unit')
  await waitForCheck(tasks, task.id)
  expect(tasks.list('project-1')[0].state).toBe('blocked')
  pass = true
  await tasks.verify('project-1', task.id, 'me', 'unit')
  await waitForCheck(tasks, task.id)
  await vi.waitFor(() => expect(tasks.list('project-1')[0].state).toBe('ready-for-review'))
  const view = await tasks.show('project-1', task.id)
  expect(view.attempts.map((a) => a.kind === 'command' ? a.status : a.kind)).toEqual(['agent-report', 'failed', 'passed'])
  expect(view.task.acceptances).toEqual([])
})

test('real command runs record output, cwd, timestamps, exit code, and revision; retries preserve results', async () => {
  const { tasks } = setup()
  const task = await tasks.create('project-1', { ...input(), requiredChecks: [...input().requiredChecks, { id: 'failure', command: 'echo failure && exit 7', cwd: repo }] })
  const first = await tasks.verify('project-1', task.id, 'me', 'unit')
  expect(first.status).toBe('running')
  await waitForCheck(tasks, task.id)
  let attempts = (await tasks.show('project-1', task.id)).attempts
  expect(attempts[0]).toMatchObject({ kind: 'command', status: 'passed', exitCode: 0, cwd: repo, revision: rev, startedAt: expect.any(Number), endedAt: expect.any(Number) })
  expect(readFileSync(first.outputRef, 'utf8')).toContain('verified')
  const second = await tasks.verify('project-1', task.id, 'me', 'failure')
  await waitForCheck(tasks, task.id)
  attempts = (await tasks.show('project-1', task.id)).attempts
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toMatchObject({ status: 'failed', exitCode: 7 })
  expect(first.id).not.toBe(second.id)
  expect(first.outputRef).not.toBe(second.outputRef)
  expect(readFileSync(second.outputRef, 'utf8')).toContain('failure')
})

test('verification does not execute before durable start record is saved', async () => {
  const { store } = setup()
  let fail = false
  const execute = vi.fn(executeVerification)
  const tasks = createTaskService(store, dir, async () => { if (fail) throw new Error('disk full') }, async () => rev, execute)
  const task = await tasks.create('project-1', input())
  fail = true
  await expect(tasks.verify('project-1', task.id, 'me', 'unit')).rejects.toThrow('disk full')
  expect(execute).not.toHaveBeenCalled()
})

test('agent routing stays in its project and enforces check definitions', async () => {
  const { store, tasks } = setup()
  const caller = store.get().nodes[0]
  const task = await taskVerb(tasks, caller, 'task-create', { brief: 'Task', criteria: ['Works'], checks: JSON.stringify(input().requiredChecks) }) as Task
  await expect(taskVerb(tasks, caller, 'task-verify', { task: task.id, check: 'unit', command: 'echo spoof' })).rejects.toThrow(/runs a declared check as it was declared/)
  await expect(taskVerb(tasks, { ...caller, projectId: 'other' }, 'task-show', { task: task.id })).rejects.toThrow(/Project not found/)
  await tasks.state('project-1', task.id, 'cancelled')
  await expect(tasks.submit('project-1', task.id, 'me', 'done')).rejects.toThrow(/cancelled/)
})

test('Git identity detects commits, index changes and changed untracked contents from a nested cwd', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' })
  git('init')
  git('config', 'user.name', 'Task test')
  git('config', 'user.email', 'task@example.invalid')
  writeFileSync(join(repo, 'file.txt'), 'one')
  git('add', '.')
  git('commit', '-m', 'initial')
  const clean = await readRevision(repo)
  expect(clean.uncommitted).toBe(false)
  expect(clean.revision).toMatch(/^[a-f0-9]{40}$/)
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'untracked.txt'), 'one')
  const dirty = await readRevision(join(repo, 'sub'))
  expect(dirty.uncommitted).toBe(true)
  expect(dirty.revision).toBe(clean.revision)
  writeFileSync(join(repo, 'sub', 'untracked.txt'), 'two')
  expect((await readRevision(join(repo, 'sub'))).fingerprint).not.toBe(dirty.fingerprint)
  git('add', '.')
  expect((await readRevision(repo)).fingerprint).not.toBe(dirty.fingerprint)
})
