import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { openAction } from '../../src/main/workflows/openPolicy'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { RunResult } from '../../src/shared/contract'
import type { AgentStatus, ClaudeNode, RunNode } from '../../src/shared/model'
import type { Workflow, WorkflowRun } from '../../src/shared/workflow'
import { createWorkflowService } from '../../src/main/workflows/service'
import { createRunStore } from '../../src/main/workflows/store'
import { withWorkflowVerbs } from '../../src/main/workflows/verbs'
import { currentAttempt } from '../../src/core/workflow/engine'
import type { Verbs } from '../../src/main/control/verbs'
import { projectStore } from '../recipes/fakes'
import { BUILT_IN_WORKFLOWS } from '../../src/shared/workflowBuiltins'
import { featureWorkflow } from './fixtures'

const dirs: string[] = []
const services: Array<{ flush(): Promise<void>; dispose(): void }> = []
afterEach(async () => {
  for (const s of services.splice(0)) { await s.flush(); s.dispose() }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fakeRunner() {
  const started: string[] = []
  const stopped: string[] = []
  const results: Record<string, RunResult> = {}
  const listeners: Array<(id: string, run: RunResult) => void> = []
  return {
    started, stopped, results,
    async startNode(id: string) { started.push(id) },
    async stopNode(id: string) { stopped.push(id) },
    runs: () => ({ ...results }),
    onRun(cb: (id: string, run: RunResult) => void) { listeners.push(cb) },
    exit(id: string, code: number) {
      results[id] = { running: false, exitCode: code, stoppedByYou: false, at: 1 }
      for (const cb of listeners) cb(id, results[id])
    }
  }
}

function fakeTracker() {
  const statuses: Record<string, AgentStatus> = {}
  const listeners: Array<(id: string, s: AgentStatus) => void> = []
  return {
    get: (id: string): AgentStatus => statuses[id] ?? 'unknown',
    onChange(cb: (id: string, s: AgentStatus) => void) { listeners.push(cb) },
    set(id: string, s: AgentStatus) {
      statuses[id] = s
      for (const cb of listeners) cb(id, s)
    }
  }
}

/** A project in a folder, a personal workflow file, and the service over them, with git and processes faked. */
function world(wf: Workflow = featureWorkflow(), opts: {
  dataDir?: string
  store?: ReturnType<typeof projectStore>
  repo?: string
  isRunning?: (id: string) => boolean
  exitGraceMs?: number
  /** Runs before each save of a run, as something else on the canvas might. */
  beforeSave?: () => void
} = {}) {
  const root = opts.repo ?? mkdtempSync(join(tmpdir(), 'pb-wf-svc-'))
  if (!opts.repo) dirs.push(root)
  const dataDir = opts.dataDir ?? join(root, 'data')
  mkdirSync(join(dataDir, 'workflows'), { recursive: true })
  writeFileSync(join(dataDir, 'workflows', 'feature.json'), JSON.stringify(wf))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const store = opts.store ?? projectStore([], repo)
  const runner = fakeRunner()
  const tracker = fakeTracker()
  const sent: Array<[string, string]> = []
  const readers: string[] = []
  const tasks = { created: [] as unknown[], submitted: [] as unknown[], verified: [] as unknown[], recorded: [] as unknown[] }
  let holding = false
  let clock = 1_000_000
  let ids = 0
  const service = createWorkflowService({
    store, runner, tracker,
    stops: { holding: () => holding },
    ...(opts.isRunning ? { isRunning: opts.isRunning } : {}),
    ...(opts.exitGraceMs !== undefined ? { exitGraceMs: opts.exitGraceMs } : {}),
    runStore: (() => {
      const real = createRunStore(join(dataDir, 'workflow-runs'), { log: () => {} })
      return { ...real, save: async (r: WorkflowRun) => { opts.beforeSave?.(); await real.save(r) } }
    })(),
    dataDir,
    launcher: 'C:\\app\\resources\\launch-run.cjs',
    toplevel: async () => repo,
    createWorktree: async (a) => {
      const path = join(root, 'wt', a.branch.replace(/\//g, '_'))
      mkdirSync(path, { recursive: true })
      return { path, branch: a.branch, repo: a.repo }
    },
    tasks: {
      async create(_p, input) { tasks.created.push(input); return { id: 'task1' } },
      async submit(...a) { tasks.submitted.push(a) },
      async verify(...a) { tasks.verified.push(a) },
      async recordRun(...a) { tasks.recorded.push(a) }
    },
    send: (id, text) => (sent.push([id, text]), { ok: true }),
    revision: async () => ({ revision: 'abc', uncommitted: false, fingerprint: 'f' }),
    openReader: async (path) => (readers.push(path), 'reader1'),
    builtIn: BUILT_IN_WORKFLOWS,
    log: () => {},
    now: () => clock,
    newId: () => `id${++ids}`
  })
  services.push(service)
  const node = (id: string | null) => store.get().nodes.find((n) => n.id === id)
  const run = (): WorkflowRun => service.runs()[0]
  const att = (step: string) => currentAttempt(run(), step)!
  return {
    root, dataDir, store, runner, tracker, service, sent, readers, tasks, node, run, att,
    hold: (v: boolean) => { holding = v },
    advanceClock: (ms: number) => { clock += ms },
    settle: () => service.flush()
  }
}

const startByPerson = async (w: ReturnType<typeof world>, inputs: Record<string, unknown> = { brief: 'Dark mode' }) => {
  const r = await w.service.start({ projectId: 'p1', ref: 'personal:Feature', inputs, by: { person: true } })
  await w.settle()
  if (!r.ok) throw new Error(r.reason)
  return r.run
}

/** Writes a plan file in the run's folder and submits it from the plan node. */
async function submitPlan(w: ReturnType<typeof world>) {
  const cwd = w.run().cwd
  writeFileSync(join(cwd, 'plan.md'), '# Plan\n')
  const r = await w.service.submit(w.att('plan').nodeId!, [{ key: 'doc', file: 'plan.md' }, { key: 'summary', text: 'A toggle' }])
  await w.settle()
  return r
}

describe('running a workflow through the service', () => {
  test('start makes a worktree, a group, the deliverable task, and the first agent node, recorded before it starts', async () => {
    const w = world()
    const run = await startByPerson(w)
    expect(run.worktree?.branch).toMatch(/^workflow\/dark-mode-/)
    const group = w.node(run.groupId)!
    expect(group).toMatchObject({ kind: 'group', title: 'Workflow: Feature — Dark mode', worktree: { branch: run.worktree!.branch } })
    expect(w.tasks.created).toEqual([expect.objectContaining({ acceptanceCriteria: ['The feature works', 'Tests pass'], requiredChecks: [{ id: 'tests', command: 'npm test --', cwd: run.cwd }] })])
    const plan = w.node(w.att('plan').nodeId) as ClaudeNode
    expect(plan).toMatchObject({ kind: 'claude', agent: 'claude', title: '1. Plan', cwd: run.cwd, parentId: group.id })
    expect(plan.prompt).toContain('Write a plan for: Dark mode')
    expect(w.runner.started).toEqual([plan.id])
    expect(w.att('plan').state).toBe('running')
    // On disk, as the store will load it after a restart.
    const saved = JSON.parse(readFileSync(join(w.dataDir, 'workflow-runs', 'runs', `${run.id}.json`), 'utf8'))
    expect(saved.attempts[0]).toMatchObject({ nodeId: plan.id, state: 'running' })
  })

  test('idle without a result never moves the run on', async () => {
    const w = world()
    await startByPerson(w)
    w.tracker.set(w.att('plan').nodeId!, 'idle')
    await w.settle()
    expect(w.run().state).toBe('waiting-for-you')
    expect(w.store.get().nodes.filter((n) => n.kind === 'claude')).toHaveLength(1)
  })

  test('the whole run: plan, review in a reader, approve, implement, failing tests, retry, success and the task', async () => {
    const w = world()
    await startByPerson(w)
    expect(await submitPlan(w)).toMatchObject({ ok: true })
    const doc = w.att('plan').outputs!.doc
    expect(doc).toMatchObject({ type: 'file', source: join(w.run().cwd, 'plan.md') })
    expect(doc.type === 'file' && readFileSync(doc.path, 'utf8')).toBe('# Plan\n')
    expect(doc.type === 'file' && doc.path.startsWith(join(w.dataDir, 'workflow-artifacts'))).toBe(true)
    expect(w.readers).toEqual([doc.type === 'file' ? doc.path : ''])
    expect(w.run().state).toBe('waiting-for-you')

    expect(await w.service.act(w.run().id, { type: 'decide', attemptId: w.att('approve').id, decision: 'approve', note: 'Small' })).toMatchObject({ ok: true })
    await w.settle()
    const impl = w.node(w.att('implement').nodeId) as ClaudeNode
    expect(impl).toMatchObject({ agent: 'codex', title: '3. Implement' })
    expect(impl.prompt).toContain('Reviewer said: Small')
    await w.service.submit(impl.id, [{ key: 'summary', text: 'Done' }])
    await w.settle()

    const tests = w.node(w.att('tests').nodeId) as RunNode
    expect(tests.kind).toBe('run')
    expect(tests.command).toMatch(/^node "C:\/app\/resources\/launch-run.cjs" ".*\.json"$/)
    const plan = JSON.parse(readFileSync(tests.command.match(/"([^"]+\.json)"$/)![1], 'utf8'))
    expect(plan).toMatchObject({ file: 'npm', args: ['test', '--'], cwd: w.run().cwd, logFile: expect.stringMatching(/log\.txt$/) })

    w.runner.exit(tests.id, 1)
    await w.settle()
    expect(w.run().state).toBe('failed')
    await w.service.act(w.run().id, { type: 'retry', step: 'tests' })
    await w.settle()
    const again = w.att('tests')
    expect(again).toMatchObject({ n: 2, via: 'retry' })
    expect(again.nodeId).not.toBe(tests.id)
    w.runner.exit(again.nodeId!, 0)
    await w.settle()
    expect(w.run().state).toBe('succeeded')
    expect(w.tasks.verified).toEqual([['p1', 'task1', impl.id, 'tests']])
    expect(w.tasks.submitted).toEqual([['p1', 'task1', impl.id, 'Done']])
  })

  test('request changes sends the note to the plan agent and reviews again', async () => {
    const w = world()
    await startByPerson(w)
    await submitPlan(w)
    const planNode = w.att('plan').nodeId!
    await w.service.act(w.run().id, { type: 'decide', attemptId: w.att('approve').id, decision: 'request-changes', note: 'Cover mobile' })
    await w.settle()
    expect(w.sent).toEqual([[planNode, expect.stringContaining('Cover mobile')]])
    expect(w.att('plan')).toMatchObject({ n: 2, nodeId: planNode, state: 'running' })
    await submitPlan(w)
    expect(w.att('approve')).toMatchObject({ n: 2, state: 'waiting-for-you' })
  })
})

describe('the reader during a review', () => {
  test('a document a waiting review shows, kept or as written, is routed to Request changes; nothing else is', async () => {
    const w = world()
    await startByPerson(w)
    await submitPlan(w)
    const doc = w.att('plan').outputs!.doc
    if (doc.type !== 'file') throw new Error('not a file')
    const target = { runId: w.run().id, attemptId: w.att('approve').id, workflow: 'Feature', step: 'Approve plan', agent: 'Plan' }
    expect(w.service.reviewFor(doc.path)).toEqual(target)
    expect(w.service.reviewFor(doc.source.toUpperCase())).toEqual(target)
    expect(w.service.reviewFor(join(w.root, 'other.md'))).toBeNull()
    // The reader's Send: the comments reach the plan agent, and the review opens again after it resubmits.
    const planNode = w.att('plan').nodeId!
    await w.service.act(target.runId, { type: 'decide', attemptId: target.attemptId, decision: 'request-changes', note: 'Comments on Plan:\n- Cover mobile' })
    await w.settle()
    expect(w.sent).toEqual([[planNode, expect.stringContaining('Cover mobile')]])
    expect(w.service.reviewFor(doc.path)).toBeNull()
  })
})

describe('who can submit', () => {
  test('only the current agent step\'s node, with files inside the run\'s folder', async () => {
    const w = world()
    await startByPerson(w)
    expect(await w.service.submit('stranger', [])).toMatchObject({ ok: false, message: expect.stringContaining("aren't running a workflow step") })
    const planNode = w.att('plan').nodeId!
    const outside = join(w.root, 'secret.md')
    writeFileSync(outside, 'x')
    expect(await w.service.submit(planNode, [{ key: 'doc', file: outside }, { key: 'summary', text: 's' }])).toMatchObject({ ok: false, message: expect.stringContaining("isn't inside the run's folder") })
    expect(await w.service.submit(planNode, [{ key: 'doc', file: 'missing.md' }, { key: 'summary', text: 's' }])).toMatchObject({ ok: false, message: expect.stringContaining("There's no file") })
    const bad = await w.service.submit(planNode, [{ key: 'summary', text: 's' }])
    expect(bad).toMatchObject({ ok: false, message: expect.stringContaining('"doc" is missing') })
  })

  test('a command step\'s node can\'t submit, and a refused submission keeps no copies', async () => {
    const w = world()
    await startByPerson(w)
    await submitPlan(w)
    await w.service.act(w.run().id, { type: 'decide', attemptId: w.att('approve').id, decision: 'approve' })
    await w.settle()
    await w.service.submit(w.att('implement').nodeId!, [{ key: 'summary', text: 'Done' }])
    await w.settle()
    writeFileSync(join(w.run().cwd, 'x.md'), 'x')
    const r = await w.service.submit(w.att('tests').nodeId!, [{ key: 'summary', text: 'x' }])
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('only an agent step') })
    const old = await w.service.submit(w.att('implement').nodeId!, [{ key: 'summary', text: 'Again' }])
    expect(old).toMatchObject({ ok: false, message: expect.stringContaining('already has its result') })
  })
})

describe('starting rules', () => {
  test('an agent can start a personal workflow only once the person has started that exact version', async () => {
    const w = world()
    w.store.dispatch({ op: 'addNode', node: { id: 'agent1', kind: 'claude', title: 'A', cwd: 'C:\\x', sessionId: null, transcriptPath: null, after: [], x: 0, y: 0, width: 10, height: 10, parentId: null, projectId: 'p1' } as ClaudeNode })
    const byAgent = () => w.service.start({ projectId: 'p1', ref: 'Feature', inputs: { brief: 'x' }, by: { agent: 'agent1' } })
    expect(await byAgent()).toMatchObject({ ok: false, reason: expect.stringContaining("hasn't started") })
    await startByPerson(w)
    expect(await byAgent()).toMatchObject({ ok: true })
    // Changed since: a new hash, not trusted.
    writeFileSync(join(w.dataDir, 'workflows', 'feature.json'), JSON.stringify({ ...featureWorkflow(), description: 'Edited' }))
    expect(await byAgent()).toMatchObject({ ok: false, reason: expect.stringContaining("hasn't started") })
  })

  test('agents can\'t start repository or built-in workflows', async () => {
    const w = world()
    const repo = w.store.get().projects[0].folder
    mkdirSync(join(repo, '.patchbay', 'workflows'), { recursive: true })
    writeFileSync(join(repo, '.patchbay', 'workflows', 'r.json'), JSON.stringify({ ...featureWorkflow(), name: 'Repo flow' }))
    w.store.dispatch({ op: 'addNode', node: { id: 'agent1', kind: 'claude', title: 'A', cwd: 'C:\\x', sessionId: null, transcriptPath: null, after: [], x: 0, y: 0, width: 10, height: 10, parentId: null, projectId: 'p1' } as ClaudeNode })
    expect(await w.service.start({ projectId: 'p1', ref: 'Repo flow', inputs: { brief: 'x' }, by: { agent: 'agent1' } })).toMatchObject({ ok: false, reason: expect.stringContaining('only the person can start it') })
  })

  test('a stale hash, bad inputs and an archived project are refused before anything is made', async () => {
    const w = world()
    expect(await w.service.start({ projectId: 'p1', ref: 'Feature', hash: 'old', inputs: { brief: 'x' }, by: { person: true } })).toMatchObject({ ok: false, reason: expect.stringContaining('has changed since it was shown') })
    expect(await w.service.start({ projectId: 'p1', ref: 'Feature', inputs: {}, by: { person: true } })).toMatchObject({ ok: false, reason: '"Feature brief" is required.' })
    w.store.dispatch({ op: 'archiveProject', id: 'p1', at: 5 })
    const archived = w.store.get().projects[0].archivedAt !== undefined
    if (archived) expect(await w.service.start({ projectId: 'p1', ref: 'Feature', inputs: { brief: 'x' }, by: { person: true } })).toMatchObject({ ok: false, reason: expect.stringContaining('archived') })
    expect(w.store.get().nodes).toEqual([])
  })
})

describe('nodes and time', () => {
  test('closing a step\'s node interrupts it; it never counts as done', async () => {
    const w = world()
    await startByPerson(w)
    w.store.dispatch({ op: 'removeNodes', ids: [w.att('plan').nodeId!], at: 5 })
    await w.settle()
    if (!w.store.get().nodes.some((n) => n.id === w.att('plan').nodeId)) {
      expect(w.att('plan').state).toBe('interrupted')
      expect(w.run().state).toBe('needs-attention')
    }
  })

  test('a usage-limit hold stops the clock; past the limit, the step fails and its node stops', async () => {
    const wf = featureWorkflow()
    wf.steps[0] = { ...wf.steps[0], timeoutMin: 1 } as Workflow['steps'][number]
    const w = world(wf)
    await startByPerson(w)
    w.hold(true)
    w.advanceClock(5 * 60_000)
    w.service.tick()
    await w.settle()
    expect(w.att('plan').state).toBe('running')
    w.hold(false)
    w.service.tick()
    await w.settle()
    // Only 30 s of hold were counted per tick, so it is now past due.
    expect(w.att('plan')).toMatchObject({ state: 'failed', why: 'Timed out after 1 min.' })
    expect(w.runner.stopped).toEqual([w.att('plan').nodeId])
  })
})

describe('after a restart', () => {
  test('a command that exited while closed advances from the host exit code; nothing is launched twice', async () => {
    const w = world()
    await startByPerson(w)
    await submitPlan(w)
    await w.service.act(w.run().id, { type: 'decide', attemptId: w.att('approve').id, decision: 'approve' })
    await w.settle()
    await w.service.submit(w.att('implement').nodeId!, [{ key: 'summary', text: 'Done' }])
    await w.settle()
    const testsNode = w.att('tests').nodeId!
    w.service.dispose()
    // Patchbay restarts: the same data, the same canvas, and the host kept the exit code.
    const again = world(featureWorkflow(), { dataDir: w.dataDir, store: w.store, repo: w.root })
    again.runner.results[testsNode] = { running: false, exitCode: 0, stoppedByYou: false, at: 1 }
    const before = w.store.get().nodes.length
    await again.service.recover()
    await again.settle()
    expect(again.run().state).toBe('succeeded')
    expect(w.store.get().nodes.length).toBe(before)
    expect(again.runner.started).toEqual([])
    again.service.dispose()
  })

  test('an attempt recorded before its node was made is interrupted, not made again', async () => {
    const w = world()
    await startByPerson(w)
    const planNode = w.att('plan').nodeId!
    w.service.dispose()
    w.store.dispatch({ op: 'removeNodes', ids: [planNode], at: 5 })
    const again = world(featureWorkflow(), { dataDir: w.dataDir, store: w.store, repo: w.root })
    await again.service.recover()
    await again.settle()
    expect(again.att('plan').state).toBe('interrupted')
    expect(again.runner.started).toEqual([])
    again.service.dispose()
  })
})

describe('verbs', () => {
  const base: Verbs = async () => ({ base: true })

  test('job-submit names no node: the caller is the node; text and files arrive as given', async () => {
    const w = world()
    await startByPerson(w)
    const verbs = withWorkflowVerbs(base, { store: w.store, service: w.service })
    writeFileSync(join(w.run().cwd, 'plan.md'), '# P')
    const r = await verbs(w.att('plan').nodeId!, 'job-submit', { outputs: [{ key: 'doc', file: join(w.run().cwd, 'plan.md') }, { key: 'summary', text: 'S' }] }) as { submitted: boolean }
    expect(r.submitted).toBe(true)
    await w.settle()
    expect(w.att('plan').state).toBe('succeeded')
    await expect(verbs(w.att('plan').nodeId!, 'job-submit', { outputs: [{ key: 'summary', text: 'S' }] })).rejects.toThrow(/already has its result/)
    expect(await verbs('x', 'list', {})).toEqual({ base: true })
  })

  test('workflows lists, previews with inputs filled in, and runs nothing', async () => {
    const w = world()
    w.store.dispatch({ op: 'addNode', node: { id: 'agent1', kind: 'claude', title: 'A', cwd: 'C:\\x', sessionId: null, transcriptPath: null, after: [], x: 0, y: 0, width: 10, height: 10, parentId: null, projectId: 'p1' } as ClaudeNode })
    const verbs = withWorkflowVerbs(base, { store: w.store, service: w.service })
    const listed = await verbs('agent1', 'workflows', {}) as { workflows: Array<{ name: string; source: string }> }
    expect(listed.workflows.map((x) => `${x.source}:${x.name}`)).toEqual(['personal:Feature', 'built-in:Plan, review, build'])
    const preview = await verbs('agent1', 'workflows', { name: 'Feature', input: ['filter=unit'] }) as { steps: Array<{ runs?: string }>; hash: string }
    expect(preview.steps[3].runs).toBe('npm test -- unit')
    expect(w.service.runs()).toEqual([])
    await expect(verbs('agent1', 'workflow-run', { name: 'Feature', input: ['brief=x'] })).rejects.toThrow(/hasn't started/)
    expect(existsSync(join(w.dataDir, 'workflow-runs', 'runs'))).toBe(false)
  })
})

describe('review fixes', () => {
  test('H1: an output key that is a path is refused, and nothing is written anywhere', async () => {
    const w = world()
    await startByPerson(w)
    const cwd = w.run().cwd
    writeFileSync(join(cwd, 'payload.bat'), 'echo pwned')
    const node = w.att('plan').nodeId!
    for (const key of ['../../../escaped', String.raw`..\..\x`, 'a/b', '']) {
      expect(await w.service.submit(node, [{ key, file: 'payload.bat' }, { key: 'summary', text: 's' }])).toMatchObject({ ok: false, message: expect.stringContaining('field name') })
    }
    expect(existsSync(join(w.dataDir, 'escaped-payload.bat'))).toBe(false)
    expect(existsSync(join(w.dataDir, 'workflow-artifacts'))).toBe(false)
  })

  test('H1: a refused submission copies nothing: an unknown field, another project, a finished attempt', async () => {
    const w = world()
    await startByPerson(w)
    const cwd = w.run().cwd
    writeFileSync(join(cwd, 'plan.md'), '# P')
    const node = w.att('plan').nodeId!
    expect(await w.service.submit(node, [{ key: 'doc', file: 'plan.md' }, { key: 'summary', text: 's' }, { key: 'extra', file: 'plan.md' }])).toMatchObject({ ok: false })
    expect(await w.service.submit(node, [{ key: 'doc', text: 'not a file' }, { key: 'summary', text: 's' }])).toMatchObject({ ok: false })
    expect(existsSync(join(w.dataDir, 'workflow-artifacts'))).toBe(false)
    expect(await submitPlan(w)).toMatchObject({ ok: true })
    // The copy is named by the key alone, inside the attempt's folder.
    const doc = w.att('plan').outputs!.doc
    expect(doc.type === 'file' && doc.path).toBe(join(w.dataDir, 'workflow-artifacts', w.run().id, `${w.att('plan').id.replace(/:/g, '_')}`, 'doc.md'))
    const again = await w.service.submit(node, [{ key: 'doc', file: 'plan.md' }, { key: 'summary', text: 'again' }])
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining('already has its result') })
  })

  test('H1: a junction inside the run folder that leads outside it is refused', async () => {
    const w = world()
    await startByPerson(w)
    const outside = join(w.root, 'secrets')
    mkdirSync(outside)
    writeFileSync(join(outside, 'key.txt'), 'secret')
    symlinkSync(outside, join(w.run().cwd, 'link'), 'junction')
    const r = await w.service.submit(w.att('plan').nodeId!, [{ key: 'doc', file: 'link/key.txt' }, { key: 'summary', text: 's' }])
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("isn't inside the run's folder") })
  })

  test('H2: after a restart, an agent the host still runs stays running though its status is unknown, and can submit', async () => {
    const w = world()
    await startByPerson(w)
    const planNode = w.att('plan').nodeId!
    w.service.dispose()
    const again = world(featureWorkflow(), { dataDir: w.dataDir, store: w.store, repo: w.root, isRunning: (id) => id === planNode })
    await again.service.recover()
    await again.settle()
    expect(again.att('plan').state).toBe('running')
    writeFileSync(join(again.run().cwd, 'plan.md'), '# P')
    expect(await again.service.submit(planNode, [{ key: 'doc', file: 'plan.md' }, { key: 'summary', text: 's' }])).toMatchObject({ ok: true })
  })

  test('H3: a value with a character cmd acts on never reaches a task check; nothing is made', async () => {
    const w = world()
    const r = await w.service.start({ projectId: 'p1', ref: 'Feature', inputs: { brief: 'x', filter: 'x&calc' }, by: { person: true } })
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('"Test filter" can\'t contain "&"') })
    expect(w.tasks.created).toEqual([])
    expect(w.store.get().nodes).toEqual([])
    expect(await w.service.start({ projectId: 'p1', ref: 'Feature', inputs: { brief: 'x & y', filter: 'unit' }, by: { person: true } })).toMatchObject({ ok: true })
  })

  test('M1: a canvas change while the run is being saved doesn\'t interrupt the step being launched', async () => {
    let w: ReturnType<typeof world>
    let n = 0
    w = world(featureWorkflow(), {
      beforeSave: () => w?.store.dispatch({ op: 'addNode', node: { id: `other${++n}`, kind: 'sticky', title: 'N', text: '', x: 0, y: 0, width: 10, height: 10, parentId: null, projectId: 'p1' } as never })
    })
    await startByPerson(w)
    expect(w.att('plan').state).toBe('running')
  })

  test('M2: restarting a step\'s agent keeps its attempt; an agent that stays exited is interrupted', async () => {
    const w = world(featureWorkflow(), { exitGraceMs: 20 })
    await startByPerson(w)
    const node = w.att('plan').nodeId!
    w.tracker.set(node, 'exited')
    w.tracker.set(node, 'starting')
    await new Promise((r) => setTimeout(r, 60))
    await w.settle()
    expect(w.att('plan').state).toBe('running')
    w.tracker.set(node, 'exited')
    await new Promise((r) => setTimeout(r, 60))
    await w.settle()
    expect(w.att('plan').state).toBe('interrupted')
  })

  test('M3: Open only shows a runnable file in its folder', () => {
    expect(openAction('C:/data/workflow-artifacts/r/a/doc.hta')).toBe('reveal')
    expect(openAction('C:/x/run.bat')).toBe('reveal')
    expect(openAction('C:/x/link.lnk')).toBe('reveal')
    expect(openAction('C:/x/doc.md')).toBe('open')
    expect(openAction('C:/x/log.txt')).toBe('open')
  })
})

describe('L1 and L2 through the service', () => {
  /** Runs the feature workflow to its tests step, running. */
  async function toTests(w: ReturnType<typeof world>) {
    await startByPerson(w)
    await submitPlan(w)
    await w.service.act(w.run().id, { type: 'decide', attemptId: w.att('approve').id, decision: 'approve' })
    await w.settle()
    await w.service.submit(w.att('implement').nodeId!, [{ key: 'summary', text: 'Done' }])
    await w.settle()
  }
  const logOf = (w: ReturnType<typeof world>) => join(w.dataDir, 'workflow-artifacts', w.run().id, w.att('tests').id.replace(/:/g, '_'), 'log.txt')

  test('L1: the passing check step is recorded as the task\'s evidence, not run again', async () => {
    const w = world()
    await toTests(w)
    mkdirSync(join(logOf(w), '..'), { recursive: true })
    writeFileSync(logOf(w), 'all passing')
    w.runner.exit(w.att('tests').nodeId!, 0)
    await w.settle()
    expect(w.tasks.verified).toEqual([])
    expect(w.tasks.recorded).toEqual([['p1', 'task1', w.att('implement').nodeId, expect.objectContaining({ checkId: 'tests', command: 'npm test --', cwd: w.run().cwd, exitCode: 0, outputRef: logOf(w) })]])
  })

  test('L1: without the step\'s evidence (no log kept), the check runs through the task service', async () => {
    const w = world()
    await toTests(w)
    w.runner.exit(w.att('tests').nodeId!, 0)
    await w.settle()
    expect(w.tasks.recorded).toEqual([])
    expect(w.tasks.verified).toHaveLength(1)
  })

  test('L2: old finished runs and their files go; open runs, unread runs\' files and in-play tasks stay', async () => {
    const wf = featureWorkflow()
    delete wf.deliverable
    ;(wf.steps[3] as { taskCheck?: boolean }).taskCheck = undefined
    const w = world(wf)
    await startByPerson(w)
    await submitPlan(w)
    const finished = w.run().id
    await w.service.act(finished, { type: 'stop' })
    await w.settle()
    const open = (await w.service.start({ projectId: 'p1', ref: 'Feature', inputs: { brief: 'Second' }, by: { person: true } }))
    await w.settle()
    const artifacts = join(w.dataDir, 'workflow-artifacts')
    mkdirSync(join(artifacts, 'orphan'), { recursive: true })
    mkdirSync(join(artifacts, 'newer-run'), { recursive: true })
    // A run file this version can't read keeps its files.
    writeFileSync(join(w.dataDir, 'workflow-runs', 'runs', 'newer-run.json'), JSON.stringify({ schema: 2, id: 'newer-run' }))
    w.service.dispose()
    const later = world(wf, { dataDir: w.dataDir, store: w.store, repo: w.root })
    later.advanceClock(91 * 24 * 60 * 60_000)
    const r = await later.service.prune()
    expect(r.removed).toEqual([finished])
    expect(existsSync(join(w.dataDir, 'workflow-runs', 'runs', `${finished}.json`))).toBe(false)
    expect(existsSync(join(artifacts, finished))).toBe(false)
    expect(existsSync(join(artifacts, 'orphan'))).toBe(false)
    expect(existsSync(join(artifacts, 'newer-run'))).toBe(true)
    expect(open.ok && later.service.get(open.run.id)).toBeTruthy()
  })
})
