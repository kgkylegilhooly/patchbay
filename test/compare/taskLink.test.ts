import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import type { RunResult } from '../../src/core/git/run'
import { createGitService, LIMITS, systemGit } from '../../src/core/git/service'
import { createWorktree, removeWorktree } from '../../src/core/worktree/service'
import { reduce } from '../../src/core/canvas/reduce'
import { createCompareReads } from '../../src/main/compare/reads'
import { createCompareService } from '../../src/main/compare/service'
import { createCompareTaskLink } from '../../src/main/compare/taskLink'
import type { StartComparison } from '../../src/shared/compare'
import type { CanvasStore } from '../../src/shared/contract'
import type { CanvasDoc } from '../../src/shared/model'
import { sanitizeTasks, taskReadiness, type Task, type TaskComparisonAttempt, type TaskRecords, type TaskVerification } from '../../src/shared/task'
import { comparisonCheckId, taskComparisonBrief, taskComparisons, withComparisonChoice } from '../../src/shared/taskCompare'
import { readRevision } from '../../src/main/tasks/verification'

let root: string
let repo: string

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  sh(path, 'init', '-q', '-b', 'main')
  sh(path, 'config', 'user.name', 'Test')
  sh(path, 'config', 'user.email', 'test@example.invalid')
  sh(path, 'config', 'commit.gpgsign', 'false')
  sh(path, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(path, 'app.txt'), 'one\ntwo\n')
  sh(path, 'add', 'app.txt')
  sh(path, 'commit', '-q', '-m', 'first')
  return path
}

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', projectId: 'p', brief: 'Make app.txt count to three', acceptanceCriteria: ['app.txt ends with three'], assignedSessionIds: [], cwd: repo,
  state: 'running', requiredChecks: [{ id: 'unit', command: 'node check.js', cwd: repo }], dependsOn: [], createdAt: 1, updatedAt: 1, acceptances: [], ...over
})

function store(tasks: TaskRecords): CanvasStore {
  let doc: CanvasDoc = { version: 3, projects: [{ id: 'p', name: 'P', folder: repo, viewport: { x: 0, y: 0, zoom: 1 }, tasks }], activeProjectId: 'p', nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
  return { get: () => doc, dispatch: (op) => void (doc = reduce(doc, op)), subscribe: () => () => {} }
}

const env = gitEnvFrom(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')))
const git = systemGit(env)
const reads = createCompareReads(git, createGitService(git))

function world(tasks: TaskRecords = { tasks: [task()], attempts: [] }) {
  const s = store(tasks)
  let code = 0
  let n = 0
  let t = 1000
  const service = createCompareService({
    store: s,
    runner: { startNode: async () => {}, stopNode: async () => {} },
    reads,
    file: join(root, 'data', 'comparisons.json'),
    createWorktree,
    removeWorktree,
    git: (cwd, args) => git(cwd, args, LIMITS.write),
    runVerify: async (argv, cwd): Promise<RunResult> => ({ code, stdout: `ran ${argv.join(' ')} in ${cwd}`, stderr: '', truncated: false, timedOut: false, missing: false }),
    now: () => (t += 1000),
    tasks: createCompareTaskLink({ store: s, dataDir: join(root, 'data'), newId: () => `run-${++n}` })
  })
  const records = (): TaskRecords => s.get().projects[0].tasks!
  return { s, service, records, setCode: (c: number) => void (code = c) }
}

async function startReq(over: Partial<StartComparison> = {}): Promise<StartComparison> {
  const info = await reads.source(repo)
  if (!info.ok) throw new Error(info.reason)
  return {
    projectId: 'p', source: repo, brief: 'Make app.txt count to three', base: info.commit, leaveOutUncommitted: false,
    attempts: [{ agent: 'claude', approach: '', branch: 'try/count-a' }, { agent: 'codex', approach: 'Use a loop', branch: 'try/count-b' }],
    verify: 'node check.js', taskId: 't1', ...over
  }
}

const branches = (): string[] => sh(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'patchbay-compare-task-')))
  repo = makeRepo(join(root, 'repo'))
})
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

test('a comparison for a task that is gone, cancelled or accepted is refused before anything is made', async () => {
  for (const [records, words] of [
    [{ tasks: [], attempts: [] }, /not in this project/],
    [{ tasks: [task({ state: 'cancelled' })], attempts: [] }, /cancelled/],
    [{ tasks: [task({ state: 'accepted' })], attempts: [] }, /already accepted/]
  ] as const) {
    const w = world(records as TaskRecords)
    const r = await w.service.start(await startReq())
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(words)
  }
  expect(branches()).toEqual(['main'])
})

test("its attempts appear on the task as that task's attempts, and the task's state is left alone", async () => {
  const w = world()
  const r = await w.service.start(await startReq())
  if (!r.ok) throw new Error(r.reason)
  const c = r.comparison
  expect(c.taskId).toBe('t1')
  const recorded = w.records().attempts.filter((a): a is TaskComparisonAttempt => a.kind === 'comparison')
  expect(recorded.map((a) => [a.key, a.branch, a.agent, a.comparisonId, a.base])).toEqual([
    ['a', 'try/count-a', 'claude', c.id, c.base.commit],
    ['b', 'try/count-b', 'codex', c.id, c.base.commit]
  ])
  expect(recorded.map((a) => a.sessionId)).toEqual(c.attempts.map((a) => a.nodeId))
  expect(w.records().tasks[0].state).toBe('running')
  // Nobody is assigned by it: the attempts' agents work in their own worktrees, not in the task's folder.
  expect(w.records().tasks[0].assignedSessionIds).toEqual([])
})

test('verification runs are recorded as real command evidence, with output, exit code and the worktree identity', async () => {
  const w = world()
  const r = await w.service.start(await startReq())
  if (!r.ok) throw new Error(r.reason)
  const a = r.comparison.attempts[0]
  writeFileSync(join(a.path, 'app.txt'), 'one\ntwo\nthree\n')
  w.setCode(1)
  expect((await w.service.verify(r.comparison.id, 'a')).ok).toBe(true)
  w.setCode(0)
  expect((await w.service.verify(r.comparison.id, 'a')).ok).toBe(true)

  const runs = w.records().attempts.filter((x): x is TaskVerification => x.kind === 'command')
  expect(runs.map((x) => [x.status, x.exitCode, x.checkId, x.comparison])).toEqual([
    ['failed', 1, comparisonCheckId('a'), { id: r.comparison.id, key: 'a' }],
    ['passed', 0, comparisonCheckId('a'), { id: r.comparison.id, key: 'a' }]
  ])
  const run = runs[1]
  expect(run.command).toBe('node check.js')
  expect(run.cwd).toBe(a.path)
  expect(run.sessionId).toBe(a.nodeId)
  // The identity is what task evidence reads elsewhere: the same function, on the attempt's worktree.
  const now = await readRevision(a.path)
  expect(run.revision).toEqual(now)
  expect(run.endRevision).toEqual(now)
  expect(run.revision.uncommitted).toBe(true)
  const output = readFileSync(run.outputRef, 'utf8')
  expect(output).toContain('Command: node check.js')
  expect(output).toContain(`ran node check.js in ${a.path}`)
  expect(output).toContain('Exit: 0')
})

test("a comparison's passing run never stands in for one of the task's required checks", async () => {
  const w = world({ tasks: [task({ requiredChecks: [{ id: comparisonCheckId('a'), command: 'node check.js', cwd: repo }] })], attempts: [] })
  const r = await w.service.start(await startReq())
  if (!r.ok) throw new Error(r.reason)
  await w.service.verify(r.comparison.id, 'a')
  const records = w.records()
  const revisions = { [repo]: await readRevision(repo) }
  const readiness = taskReadiness(records, records.tasks[0], revisions)
  expect(readiness.reasons).toContain(`${comparisonCheckId('a')}: missing or not passing`)
})

test('choosing records it on the task, moves with a new choice, clears, and never accepts or merges', async () => {
  const w = world()
  const r = await w.service.start(await startReq())
  if (!r.ok) throw new Error(r.reason)
  const head = sh(repo, 'rev-parse', 'HEAD')
  const chosen = (): Record<string, unknown> => Object.fromEntries(w.records().attempts.filter((a): a is TaskComparisonAttempt => a.kind === 'comparison').map((a) => [a.key, a.chosen?.head ?? null]))

  expect((await w.service.choose(r.comparison.id, 'b')).ok).toBe(true)
  expect(chosen()).toEqual({ a: null, b: head })
  await w.service.choose(r.comparison.id, 'a')
  expect(chosen()).toEqual({ a: head, b: null })
  await w.service.choose(r.comparison.id, null)
  expect(chosen()).toEqual({ a: null, b: null })

  expect(w.records().tasks[0].state).toBe('running')
  expect(w.records().tasks[0].acceptances).toEqual([])
  expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(branches().sort()).toEqual(['main', 'try/count-a', 'try/count-b'])
})

test('a task removed after the start leaves the comparison working, with nothing written anywhere', async () => {
  const w = world()
  const r = await w.service.start(await startReq())
  if (!r.ok) throw new Error(r.reason)
  w.s.dispatch({ op: 'setTasks', projectId: 'p', tasks: { tasks: [], attempts: [] } })
  expect((await w.service.verify(r.comparison.id, 'b')).ok).toBe(true)
  expect((await w.service.choose(r.comparison.id, 'b')).ok).toBe(true)
  expect(w.records()).toEqual({ tasks: [], attempts: [] })
  expect(existsSync(join(root, 'data', 'task-output'))).toBe(false)
})

test('comparison records survive loading, and damaged ones are dropped one by one', () => {
  const good: TaskComparisonAttempt = { kind: 'comparison', id: 'comparison-c-a', taskId: 't1', sessionId: 'n', startedAt: 1, comparisonId: 'c', key: 'a', title: 'T', agent: 'claude', branch: 'try/x-a', path: 'C:/x', base: 'abc', revision: { revision: 'abc', uncommitted: false, fingerprint: null }, chosen: { at: 2, head: null } }
  const run: TaskVerification = { kind: 'command', id: 'r', taskId: 't1', sessionId: 'n', checkId: 'comparison A', command: 'npm test', cwd: 'C:/x', startedAt: 1, endedAt: 2, exitCode: 0, status: 'passed', outputRef: 'C:/o.log', revision: { revision: 'abc', uncommitted: false, fingerprint: 'f' }, comparison: { id: 'c', key: 'a' } }
  const loaded = sanitizeTasks({ tasks: [], attempts: [good, run, { ...good, id: 'bad', key: 'c' }, { ...run, id: 'bad2', comparison: { id: 1, key: 'a' } }] })
  expect(loaded?.records.attempts.map((a) => a.id)).toEqual(['comparison-c-a', 'r'])
  expect(loaded?.dropped).toBe(2)
})

test("a task's comparisons are shown from its own records: attempts, latest runs and the choice", () => {
  const base = { taskId: 't1', startedAt: 5, title: 'Try', agent: 'codex', path: 'C:/w', base: 'abc', revision: { revision: 'abc', uncommitted: false, fingerprint: null } }
  const a: TaskComparisonAttempt = { ...base, kind: 'comparison', id: 'ca', sessionId: 'na', comparisonId: 'c', key: 'a', branch: 'try/a' }
  const b: TaskComparisonAttempt = { ...base, kind: 'comparison', id: 'cb', sessionId: 'nb', comparisonId: 'c', key: 'b', branch: 'try/b' }
  const run = (id: string, key: 'a' | 'b', status: 'passed' | 'failed'): TaskVerification => ({ kind: 'command', id, taskId: 't1', sessionId: 'n', checkId: comparisonCheckId(key), command: 'npm test', cwd: 'C:/w', startedAt: 6, endedAt: 7, exitCode: status === 'passed' ? 0 : 1, status, outputRef: 'o', revision: base.revision, comparison: { id: 'c', key } })
  let records: TaskRecords = { tasks: [], attempts: [b, a, run('r1', 'a', 'failed'), run('r2', 'a', 'passed')] }
  records = withComparisonChoice(records, 't1', 'c', { key: 'b', at: 9, head: 'def' })
  const [view] = taskComparisons(records.attempts)
  expect(view.attempts.map((x) => [x.record.key, x.run?.status ?? null, x.runs])).toEqual([['a', 'passed', 2], ['b', null, 0]])
  expect(view.chosen?.key).toBe('b')
  expect(taskComparisonBrief({ brief: 'Do it', acceptanceCriteria: ['works', ' '] })).toBe('Do it\n\nAcceptance criteria:\n- works')
})
