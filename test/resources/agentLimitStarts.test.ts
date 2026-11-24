import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createNodeRunner } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { SessionSpec } from '../../src/shared/contract'
import type { CanvasNode } from '../../src/shared/model'
import type { Settings } from '../../src/shared/settings'
import { claudeNode, fakeHost, memoryStore } from '../control/fakes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay agent limit '))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function runnerWith(nodes: CanvasNode[], settings: () => Settings, refreshHost?: (host: ReturnType<typeof fakeHost>) => Promise<unknown>) {
  const store = memoryStore(nodes)
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  const specs: SessionSpec[] = []
  host.start = (spec) => {
    specs.push(spec)
    host.running.add(spec.nodeId)
  }
  const exits: Array<(id: string, code: number) => void> = []
  host.onExit = (cb) => void exits.push(cb)
  // As the real host does: a killed session reports its exit.
  host.kill = async (id) => {
    host.running.delete(id)
    for (const cb of exits) cb(id, 1)
  }
  const runner = createNodeRunner({
    host,
    tracker,
    store,
    ctx: {
      sessionDir: join(dir, 'sessions'),
      hookScript: 'C:/hook.cjs',
      pluginDir: 'C:/skill',
      cliDir: 'C:/cli',
      endpointFile: 'C:/endpoint.json',
      secret: 'sec',
      claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
      codex: { file: 'C:\\bin\\codex.exe', prefixArgs: [] },
      baseEnv: { PATH: 'C:\\Windows' },
      settings,
      ...(refreshHost ? { refreshHost: () => refreshHost(host) } : {})
    }
  })
  return { runner, host, specs, tracker }
}

const started = (specs: SessionSpec[]): string[] => specs.map((s) => s.nodeId)

test('past the soft limit a new agent does not start and says why; running ones are never stopped', async () => {
  let settings: Settings = { agentLimit: '2' }
  const nodes = ['a', 'b', 'c'].map((id) => claudeNode(id, { cwd: dir }))
  const { runner, host, specs } = runnerWith(nodes, () => settings)
  await runner.startNode('a')
  await runner.startNode('b')
  await runner.startNode('c')
  expect(started(specs)).toEqual(['a', 'b'])
  expect(runner.errors().c).toEqual({ code: 'spawn-failed', message: expect.stringMatching(/^Not started: 2 agents are already running, and your limit is 2/), fix: 'sessions' })

  // Lowering the limit stops nothing.
  settings = { agentLimit: '1' }
  expect(host.isRunning('a') && host.isRunning('b')).toBe(true)

  // With one closed and the limit back up, it starts.
  settings = { agentLimit: '2' }
  await runner.stopNode('a')
  await runner.startNode('c')
  expect(started(specs)).toEqual(['a', 'b', 'c'])
  expect(runner.errors().c).toBeUndefined()
})

test("a start refused at the limit is marked as one that never ran, so it isn't taken for an exit", async () => {
  const nodes = ['a', 'b'].map((id) => claudeNode(id, { cwd: dir }))
  const { runner, tracker } = runnerWith(nodes, () => ({ agentLimit: '1' }))
  const told: Array<[string, string, boolean | undefined]> = []
  tracker.onChange((id, status, info) => told.push([id, status, info?.notStarted]))
  await runner.startNode('a')
  await runner.startNode('b')
  expect(told.filter(([id]) => id === 'b')).toEqual([['b', 'exited', true]])
})

test('a restart of a running agent at the limit goes ahead, and so does one restored after the app restarts', async () => {
  const nodes = ['a', 'b', 'r'].map((id) => claudeNode(id, { cwd: dir }))
  const { runner, specs } = runnerWith(nodes, () => ({ agentLimit: '2' }))
  await runner.startNode('a')
  await runner.startNode('b')
  await runner.restartNode('a')
  expect(started(specs)).toEqual(['a', 'b', 'a'])
  await runner.startNode('r', { restored: true })
  expect(started(specs)).toEqual(['a', 'b', 'a', 'r'])
})

test('terminals are not agents, and no limit means no limit', async () => {
  const term: CanvasNode = { id: 't', kind: 'terminal', title: 't', x: 0, y: 0, width: 400, height: 300, parentId: null, cwd: dir }
  const { runner, specs } = runnerWith([claudeNode('a', { cwd: dir }), term, claudeNode('b', { cwd: dir })], () => ({ agentLimit: '1' }))
  await runner.startNode('a')
  await runner.startNode('t')
  expect(started(specs)).toEqual(['a', 't'])
  const free = runnerWith([claudeNode('x', { cwd: dir }), claudeNode('y', { cwd: dir })], () => ({}))
  await free.runner.startNode('x')
  await free.runner.startNode('y')
  expect(started(free.specs)).toEqual(['x', 'y'])
})

test('at the limit, a session the host already runs out of sight is joined, not refused (session-sync)', async () => {
  let asked = 0
  const nodes = ['a', 'b'].map((id) => claudeNode(id, { cwd: dir }))
  const { runner, specs, host } = runnerWith(nodes, () => ({ agentLimit: '1' }), async (h) => {
    asked++
    // The host's list shows b running: the mirror is brought up to date.
    h.running.add('b')
    return [{ id: 'b', running: true }]
  })
  await runner.startNode('a')
  await runner.startNode('b')
  expect(asked).toBe(1)
  expect(started(specs)).toEqual(['a'])
  expect(host.isRunning('b')).toBe(true)
  expect(runner.errors().b).toBeUndefined()
})

test("at the limit, one the host doesn't run is still refused after asking", async () => {
  const nodes = ['a', 'b'].map((id) => claudeNode(id, { cwd: dir }))
  const { runner, specs } = runnerWith(nodes, () => ({ agentLimit: '1' }), async () => [])
  await runner.startNode('a')
  await runner.startNode('b')
  expect(started(specs)).toEqual(['a'])
  expect(runner.errors().b?.message).toMatch(/^Not started: 1 agent is already running/)
})
