import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { memoryHoldReason } from '../../src/core/resources/pressure'
import { createNodeRunner } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { SessionSpec } from '../../src/shared/contract'
import type { CanvasNode } from '../../src/shared/model'
import type { SystemMemory } from '../../src/shared/resources'
import { claudeNode, fakeHost, memoryStore, terminalNode } from '../control/fakes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay memory hold '))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const GB = 1024 ** 3
/** Commit nearly gone: 1 GB of 40 GB left. */
const SHORT: SystemMemory = { totalPhys: 32 * GB, availPhys: 8 * GB, commitLimit: 40 * GB, commitAvail: 1 * GB }
const PLENTY: SystemMemory = { ...SHORT, commitAvail: 20 * GB }

function runnerWith(nodes: CanvasNode[], memory: () => SystemMemory | null) {
  const store = memoryStore(nodes)
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  const specs: SessionSpec[] = []
  host.start = (spec) => {
    specs.push(spec)
    host.running.add(spec.nodeId)
  }
  host.pid = (id) => (host.running.has(id) ? 4242 : null)
  const exits: Array<(id: string, code: number) => void> = []
  host.onExit = (cb) => void exits.push(cb)
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
      systemMemory: memory
    }
  })
  return { runner, host, specs }
}

const started = (specs: SessionSpec[]): string[] => specs.map((s) => s.nodeId)

describe('memoryHoldReason', () => {
  test('only commit running short holds a start, and the reason says how much is left and what happens next', () => {
    expect(memoryHoldReason(SHORT)).toMatch(/^Waiting for memory: Windows has 1\.0 GB of 40\.0 GB left to give programs.*starts by itself.*Start now/)
    expect(memoryHoldReason(PLENTY)).toBeNull()
    // Low RAM alone only slows the PC; it doesn't stop programs starting.
    expect(memoryHoldReason({ ...PLENTY, availPhys: 0.5 * GB })).toBeNull()
    expect(memoryHoldReason(null)).toBeNull()
  })
})

describe('new agent starts while Windows is nearly out of memory', () => {
  test('a new agent waits, saying why; a terminal and an agent restored after a restart start as usual', async () => {
    const nodes = [claudeNode('a', { cwd: dir }), claudeNode('r', { cwd: dir }), terminalNode('t', { cwd: dir })]
    const { runner, specs } = runnerWith(nodes, () => SHORT)
    await runner.startNode('a')
    await runner.startNode('r', { restored: true })
    await runner.startNode('t')
    expect(started(specs)).toEqual(['r', 't'])
    expect(runner.errors().a).toEqual({ code: 'spawn-failed', message: expect.stringMatching(/^Waiting for memory/), fix: 'memory' })
  })

  test('held agents start once memory frees up, one per check, longest-waiting first', async () => {
    let memory = SHORT
    const nodes = ['a', 'b'].map((id) => claudeNode(id, { cwd: dir }))
    const { runner, specs } = runnerWith(nodes, () => memory)
    await runner.startNode('a')
    await runner.startNode('b')
    await runner.startHeld()
    expect(started(specs)).toEqual([])
    memory = PLENTY
    await runner.startHeld()
    expect(started(specs)).toEqual(['a'])
    expect(runner.errors().a).toBeUndefined()
    await runner.startHeld()
    expect(started(specs)).toEqual(['a', 'b'])
    await runner.startHeld()
    expect(started(specs)).toEqual(['a', 'b'])
  })

  test('Start now goes ahead anyway, and a held agent closed meanwhile is never started', async () => {
    const nodes = ['a', 'b'].map((id) => claudeNode(id, { cwd: dir }))
    let memory = SHORT
    const { runner, specs } = runnerWith(nodes, () => memory)
    await runner.startNode('a')
    await runner.startNode('b')
    await runner.restartOrJoin('a', { pastMemory: true })
    expect(started(specs)).toEqual(['a'])
    await runner.stopNode('b')
    memory = PLENTY
    await runner.startHeld()
    expect(started(specs)).toEqual(['a'])
  })

  test('restarting a running agent is never held, since it would be left stopped', async () => {
    let memory = PLENTY
    const { runner, specs } = runnerWith([claudeNode('a', { cwd: dir })], () => memory)
    await runner.startNode('a')
    memory = SHORT
    await runner.restartNode('a')
    expect(started(specs)).toEqual(['a', 'a'])
    await runner.endAndRestart('a')
    expect(started(specs)).toEqual(['a', 'a', 'a'])
    expect(runner.errors().a).toBeUndefined()
  })
})
