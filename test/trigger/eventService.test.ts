import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { canonicalSpec } from '../../src/core/trigger/arming'
import type { RunResult as ProgramResult } from '../../src/core/git/run'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTriggerService, OWN_TURN_START_MS } from '../../src/main/triggers/service'
import type { RunResult } from '../../src/shared/contract'
import type { CanvasNode, RunNode, TriggerNode, TriggerSchedule } from '../../src/shared/model'
import { claudeNode, fakeHost, memoryStore, terminalNode } from '../control/fakes'
import { triggerNode } from './fixtures'

const SEC = 1000
const MIN = 60_000
let clock = 0

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000_000
})
afterEach(() => vi.useRealTimers())

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`
const cwd = process.cwd()
const runNode = (id: string): RunNode => ({ id, kind: 'run', title: 'npm test', x: 0, y: 0, width: 300, height: 200, parentId: null, cwd, command: 'npm test' })
const ok = (code: number | null, out = ''): ProgramResult => ({ code, stdout: out, stderr: '', truncated: false, timedOut: false, missing: false })

function setup(schedule: TriggerSchedule, over: Partial<TriggerNode> = {}, extra: CanvasNode[] = []) {
  const store = memoryStore([claudeNode('a', { title: 'Builder' }), claudeNode('c', { title: 'Reviewer' }), terminalNode('t'), runNode('r'), triggerNode('tr', { schedule, targetId: 'c', ...over }), ...extra])
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  for (const id of ['a', 'c', 't']) host.running.add(id)
  const queue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), timing: { enterDelayMs: 0, settleMs: 10 } })
  const runListeners: Array<(id: string, run: RunResult) => void> = []
  const checks: Array<{ argv: string[]; cwd: string; done: (r: ProgramResult) => void }> = []
  const watches: Array<{ folder: string; change: (rel: string) => void; error: (e: Error) => void; closed: boolean }> = []
  const service = createTriggerService({
    store,
    tracker,
    host,
    queue,
    now: () => clock,
    runs: { onRun: (cb) => runListeners.push(cb) },
    preflight: (argv, dir) => new Promise((done) => checks.push({ argv, cwd: dir, done })),
    watch: (folder, change, error) => {
      const w = { folder, change, error, closed: false }
      watches.push(w)
      return { close: () => (w.closed = true) }
    }
  })
  const trig = () => store.get().nodes.find((n) => n.id === 'tr') as TriggerNode
  const typed = () => host.writes.filter(([, d]) => d !== '\r').map(([id, d]) => `${id}:${d}`)
  const arm = () => service.arm('tr', canonicalSpec(trig()))
  const idle = (id: string) => {
    tracker.apply(id, { type: 'launched' })
    tracker.apply(id, { type: 'hook', name: 'SessionStart' })
  }
  const turn = (id: string) => {
    tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
    tracker.apply(id, { type: 'hook', name: 'Stop' })
  }
  const later = (ms: number) => {
    clock += ms
    vi.advanceTimersByTime(ms)
  }
  const runEnds = (exitCode: number, stoppedByYou = false) => runListeners.forEach((cb) => cb('r', { running: false, exitCode, stoppedByYou, at: clock }))
  return { store, tracker, host, service, trig, typed, arm, idle, turn, later, runEnds, checks, watches }
}

const AGENT_TURN: TriggerSchedule = { type: 'agent', nodeId: 'a', on: 'turn' }

describe('agent events', () => {
  test('a finished turn sends the prompt, with the event filled in', () => {
    const s = setup(AGENT_TURN, { prompt: '{{node}} {{event}}. Review it.' })
    s.idle('a')
    s.idle('c')
    s.service.start()
    expect(s.arm()).toEqual({ ok: true })
    expect(s.trig().nextAt).toBeNull()
    s.turn('a')
    expect(s.typed()).toEqual([`c:${paste('Builder "Builder" finished a turn. Review it.')}`])
    expect(s.trig().runs[0]).toMatchObject({ source: 'event', outcome: 'delivered', event: '"Builder" finished a turn' })
    // It stays armed: an event trigger has no last slot to spend.
    expect(s.trig().armedSpec).not.toBeNull()
  })

  test('needs-you and exit fire only the trigger waiting for them', () => {
    const s = setup({ type: 'agent', nodeId: 'a', on: 'needs-you' })
    s.idle('a')
    s.idle('c')
    s.service.start()
    s.arm()
    s.turn('a')
    expect(s.typed()).toEqual([])
    s.tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
    s.tracker.apply('a', { type: 'hook', name: 'PermissionRequest' })
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered', event: '"Builder" needs you' })

    const e = setup({ type: 'agent', nodeId: 'a', on: 'exit' })
    e.idle('a')
    e.idle('c')
    e.service.start()
    e.arm()
    e.tracker.apply('a', { type: 'process-exit' })
    expect(e.trig().runs[0]).toMatchObject({ outcome: 'delivered', event: '"Builder" exited' })
  })

  test('nothing fires for what happened before it started listening, or while disarmed', () => {
    const s = setup(AGENT_TURN)
    s.idle('a')
    s.idle('c')
    s.turn('a') // before start: the app was catching up
    s.service.start()
    s.turn('a') // not armed yet
    expect(s.trig().runs).toEqual([])
    s.arm()
    s.service.disarm('tr')
    s.turn('a')
    expect(s.trig().runs).toEqual([])
  })

  test('a busy target gets it once idle, through the send queue', () => {
    const s = setup(AGENT_TURN)
    s.idle('a')
    s.idle('c')
    s.tracker.apply('c', { type: 'hook', name: 'UserPromptSubmit' })
    s.service.start()
    s.arm()
    s.turn('a')
    expect(s.trig().runs[0].outcome).toBe('queued')
    s.tracker.apply('c', { type: 'hook', name: 'Stop' })
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered', detail: /once it was idle/ })
  })
})

describe('loop protection', () => {
  test('a trigger sending to the agent it watches doesn\'t fire on the turn its own prompt started', () => {
    const s = setup(AGENT_TURN, { targetId: 'a', prompt: 'keep going', limits: { gapMs: 5 * SEC, perHour: 60 } })
    s.idle('a')
    s.service.start()
    s.arm()
    s.turn('a') // the person's turn
    expect(s.typed()).toEqual([`a:${paste('keep going')}`])
    s.later(10 * SEC)
    s.turn('a') // the turn "keep going" started
    expect(s.typed()).toHaveLength(1)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: /own prompt/ })
    s.later(10 * SEC)
    s.turn('a') // the person again
    expect(s.typed()).toHaveLength(2)
  })

  test('the idle a waiting prompt is delivered on is someone else\'s turn ending, not its own', () => {
    const s = setup({ type: 'agent', nodeId: 'a', on: 'needs-you' }, { targetId: 'a', limits: { gapMs: 5 * SEC, perHour: 60 } })
    s.idle('a')
    s.service.start()
    s.arm()
    s.tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
    s.tracker.apply('a', { type: 'hook', name: 'PermissionRequest' })
    expect(s.trig().runs[0].outcome).toBe('queued')
    s.tracker.apply('a', { type: 'hook', name: 'Stop' })
    expect(s.trig().runs[0].outcome).toBe('delivered')
    s.later(10 * SEC)
    // Its own turn asks for permission: that doesn't fire it.
    s.tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
    s.tracker.apply('a', { type: 'hook', name: 'PermissionRequest' })
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: /own prompt/ })
  })

  test('file changes during the turn its own prompt started don\'t fire it', () => {
    const s = setup({ type: 'files', folder: cwd, glob: '*.ts', quietMs: 5 * SEC }, { limits: { gapMs: 5 * SEC, perHour: 60 } })
    s.idle('c')
    s.service.start()
    s.arm()
    s.watches[0].change('src/a.ts')
    s.later(5 * SEC)
    expect(s.trig().runs[0].outcome).toBe('delivered')
    s.tracker.apply('c', { type: 'hook', name: 'UserPromptSubmit' })
    s.watches[0].change('src/b.ts')
    s.later(3 * SEC)
    s.tracker.apply('c', { type: 'hook', name: 'Stop' })
    s.later(5 * SEC)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: /during the turn/ })
    // Afterwards, the person's own edit fires it again.
    s.later(30 * SEC)
    s.watches[0].change('src/c.ts')
    s.later(5 * SEC)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered', event: /1 file changed/ })
  })

  test('a prompt that never starts a turn doesn\'t silence the trigger', () => {
    const s = setup({ type: 'files', folder: cwd, glob: '*', quietMs: 1 * SEC }, { limits: { gapMs: 5 * SEC, perHour: 60 } })
    s.idle('c')
    s.service.start()
    s.arm()
    s.watches[0].change('a')
    s.later(SEC)
    expect(s.trig().runs[0].outcome).toBe('delivered')
    s.later(OWN_TURN_START_MS + SEC)
    s.watches[0].change('b')
    s.later(SEC)
    expect(s.trig().runs[0].outcome).toBe('delivered')
    expect(s.trig().runs).toHaveLength(2)
  })
})

describe('limits', () => {
  test('cool-down skips are recorded, and repeats fold into one row', () => {
    const s = setup(AGENT_TURN, { limits: { gapMs: MIN, perHour: 10 } })
    s.idle('a')
    s.idle('c')
    s.service.start()
    s.arm()
    s.turn('a')
    s.later(SEC)
    s.turn('a')
    s.later(SEC)
    s.turn('a')
    expect(s.typed()).toHaveLength(1)
    expect(s.trig().runs).toHaveLength(2)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', repeats: 2, detail: 'Cool-down: it fires at most once every 1 minute.' })
    s.later(MIN)
    s.turn('a')
    expect(s.typed()).toHaveLength(2)
  })

  test('the hourly cap', () => {
    const s = setup(AGENT_TURN, { limits: { gapMs: 5 * SEC, perHour: 2 } })
    s.idle('a')
    s.idle('c')
    s.service.start()
    s.arm()
    for (let i = 0; i < 3; i++) {
      s.turn('a')
      s.later(10 * SEC)
    }
    expect(s.typed()).toHaveLength(2)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: /Hourly limit: it already fired 2 times/ })
    s.later(61 * MIN)
    s.turn('a')
    expect(s.typed()).toHaveLength(3)
  })

  test('Run now is the person asking: no cool-down, no check', () => {
    const s = setup(AGENT_TURN, { prompt: 'from {{node}}: {{event}}', preflight: { argv: ['npm', 'test'], cwd } })
    s.idle('a')
    s.idle('c')
    s.service.start()
    s.arm()
    expect(s.service.runNow('tr')).toMatchObject({ ok: true, run: { outcome: 'delivered', source: 'manual' } })
    expect(s.checks).toHaveLength(0)
    expect(s.typed()).toEqual([`c:${paste('from : run by hand')}`])
  })
})

describe('run node events', () => {
  test('failed only: a zero exit is not the event; a non-zero one fires', () => {
    const s = setup({ type: 'run', nodeId: 'r', failedOnly: true }, { prompt: '{{node}} exited {{exitCode}}' })
    s.idle('c')
    s.service.start()
    s.arm()
    s.runEnds(0)
    expect(s.trig().runs).toEqual([])
    s.runEnds(2)
    expect(s.typed()).toEqual([`c:${paste('npm test exited 2')}`])
  })

  test('a run you stopped didn\'t finish', () => {
    const s = setup({ type: 'run', nodeId: 'r', failedOnly: false })
    s.idle('c')
    s.service.start()
    s.arm()
    s.runEnds(1, true)
    expect(s.trig().runs).toEqual([])
    s.runEnds(0)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered', event: '"npm test" finished with exit code 0' })
  })

  test('deleting the run node it watches disarms it', () => {
    const s = setup({ type: 'run', nodeId: 'r', failedOnly: false })
    s.service.start()
    s.arm()
    s.store.dispatch({ op: 'removeNodes', ids: ['r'], at: clock })
    expect(s.trig().armedSpec).toBeNull()
  })
})

describe('file events', () => {
  test('typed into a terminal, a file name can\'t run anything in the shell', () => {
    const s = setup({ type: 'files', folder: cwd, glob: '*', quietMs: SEC }, { prompt: 'npx eslint {{files}}', targetId: 't' })
    s.service.start()
    s.arm()
    s.watches[0].change('src/x;rm -rf ~$(evil)`id`|"q".ts')
    s.later(SEC)
    expect(s.typed()).toEqual(['t:npx eslint src/x_rm -rf ___evil__id__q.ts'])
  })

  test('changes are gathered until quiet, matched, and listed', () => {
    const s = setup({ type: 'files', folder: cwd, glob: 'src/**/*.ts', quietMs: 5 * SEC }, { prompt: 'Changed: {{files}}' })
    s.idle('c')
    s.service.start()
    expect(s.watches).toHaveLength(0)
    s.arm()
    expect(s.watches).toHaveLength(1)
    const w = s.watches[0]
    w.change('src\\a.ts')
    s.later(3 * SEC)
    w.change('src/b.ts')
    w.change('README.md')
    w.change('node_modules/x/src/c.ts')
    w.change('.git/src/d.ts')
    s.later(3 * SEC)
    expect(s.typed()).toEqual([])
    s.later(2 * SEC)
    expect(s.typed()).toEqual([`c:${paste('Changed: src/a.ts, src/b.ts')}`])
  })

  test('disarming stops watching; a watch that fails is recorded and disarms', () => {
    const s = setup({ type: 'files', folder: cwd, glob: '*', quietMs: 5 * SEC })
    s.service.start()
    s.arm()
    s.service.disarm('tr')
    expect(s.watches[0].closed).toBe(true)
    s.arm()
    s.watches[1].error(new Error('The folder was removed.'))
    expect(s.watches[1].closed).toBe(true)
    expect(s.trig().armedSpec).toBeNull()
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'failed', detail: /Stopped watching .*The folder was removed/ })
  })
})

describe('preflight', () => {
  test('fires only if the check exits 0, and records its result', async () => {
    const s = setup(AGENT_TURN, { preflight: { argv: ['npm', 'test'], cwd }, limits: { gapMs: 5 * SEC, perHour: 60 } })
    s.idle('a')
    s.idle('c')
    s.service.start()
    s.arm()
    s.turn('a')
    expect(s.checks[0]).toMatchObject({ argv: ['npm', 'test'], cwd })
    expect(s.typed()).toEqual([])
    s.checks[0].done(ok(1, 'FAIL parser.test.ts\n1 failed'))
    await vi.waitFor(() => expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: 'The check "npm test" exited 1, so it didn\'t fire.', preflight: { code: 1, tail: 'FAIL parser.test.ts\n1 failed' } }))
    expect(s.typed()).toEqual([])

    s.later(10 * SEC)
    s.turn('a')
    s.checks[1].done(ok(0, 'all passed'))
    await vi.waitFor(() => expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered', preflight: { code: 0 } }))
    expect(s.typed()).toHaveLength(1)
  })

  test('one check at a time; changing the trigger while it runs means it doesn\'t fire', async () => {
    const s = setup(AGENT_TURN, { preflight: { argv: ['npm', 'test'], cwd }, limits: { gapMs: 5 * SEC, perHour: 60 } })
    s.idle('a')
    s.idle('c')
    s.service.start()
    s.arm()
    s.turn('a')
    s.later(10 * SEC)
    s.turn('a')
    expect(s.checks).toHaveLength(1)
    expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: /still running/ })
    s.store.dispatch({ op: 'patchNode', id: 'tr', patch: { prompt: 'changed' } })
    s.checks[0].done(ok(0))
    await vi.waitFor(() => expect(s.trig().runs[0]).toMatchObject({ outcome: 'skipped', detail: /disarmed or changed while its check ran/ }))
    expect(s.typed()).toEqual([])
  })

  test('a schedule trigger runs its check too, and a check that can\'t start says so', async () => {
    const s = setup({ type: 'interval', everyMs: MIN }, { preflight: { argv: ['nope'], cwd } })
    s.idle('c')
    s.service.start()
    s.arm()
    clock += MIN
    s.service.tick()
    s.checks[0].done({ ...ok(null), missing: true })
    await vi.waitFor(() => expect(s.trig().runs[0]).toMatchObject({ source: 'schedule', outcome: 'skipped', detail: /couldn't start nope/ }))
    expect(s.trig().armedSpec).not.toBeNull()
  })

  test('a one-off waits for its check before it counts as done', async () => {
    const s = setup({ type: 'once', at: 1_000_000 + MIN }, { preflight: { argv: ['npm', 'test'], cwd } })
    s.idle('c')
    s.service.start()
    s.arm()
    clock += MIN
    s.service.tick()
    expect(s.trig().armedSpec).not.toBeNull()
    s.checks[0].done(ok(0))
    await vi.waitFor(() => expect(s.trig().runs[0]).toMatchObject({ outcome: 'delivered' }))
    expect(s.trig().armedSpec).toBeNull()
  })
})
