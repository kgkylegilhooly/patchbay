import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { createNodeRunner, type NodeRunnerContext } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasStore } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, ClaudeNode } from '../../src/shared/model'
import { cleanUp, client, fakeSessions, loseAndComeBack, pipeName, serve } from '../support/fakeHost'

/**
 * Restart on a node the canvas showed as ended while the host still ran its program. It used to fail with "Session
 * <id> is already running." every time, until the person ended the process in Task Manager. See
 * docs/plans/session-sync.md.
 */
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay join '))
})
afterEach(async () => {
  await cleanUp()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function memoryStore(nodes: CanvasNode[]): CanvasStore {
  let doc: CanvasDoc = { version: 3, projects: [], activeProjectId: '', nodes, edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
  return {
    get: () => doc,
    dispatch(op) {
      doc = reduce(doc, op)
    },
    subscribe: () => () => {}
  }
}

const claude = (): ClaudeNode => ({ id: 'c', kind: 'claude', title: 'Claude', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: dir, sessionId: null, transcriptPath: null, after: [] })

async function scene(over: Partial<NodeRunnerContext> = {}) {
  const pipe = pipeName()
  const fake = fakeSessions()
  const server = await serve(pipe, fake.host)
  const app = client(pipe)
  await app.connect()
  const store = memoryStore([claude()])
  const tracker = createStatusTracker({ notify: () => {} })
  const reattached: string[] = []
  const runner = createNodeRunner({
    host: app,
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
      baseEnv: { PATH: 'C:\\Windows' },
      onReattached: (id) => reattached.push(id),
      ...over
    }
  })
  await runner.startNode('c')
  writeFileSync(join(dir, 'conv-1.jsonl'), '{}')
  await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 'conv-1', transcript_path: join(dir, 'conv-1.jsonl') })
  await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit' })
  // The host stops answering for a while, and the app counts its sessions as ended.
  await loseAndComeBack(pipe, server, fake.host, app)
  return { fake, app, store, tracker, runner, reattached }
}

describe('Restart on a node whose session the host still runs', () => {
  test('shows that session again instead of refusing', async () => {
    const { fake, app, tracker, runner, reattached } = await scene()
    expect(tracker.get('c')).toBe('exited')

    expect(await runner.restartOrJoin('c')).toBe('joined')
    expect(runner.errors().c).toBeUndefined()
    expect(app.isRunning('c')).toBe(true)
    // Nothing is known of what it did meanwhile, so it claims nothing until a hook says.
    expect(tracker.get('c')).toBe('unknown')
    expect(reattached).toEqual(['c'])
    expect(fake.specs).toHaveLength(1)

    // It's live: keys reach it, and its hooks are heard again.
    app.write('c', 'go\r')
    await vi.waitFor(() => expect(fake.writes).toEqual([['c', 'go\r']]))
    await runner.handleHook('c', { hook_event_name: 'Stop' })
    expect(tracker.get('c')).toBe('idle')
  })

  test('End and restart ends the whole tree, then resumes the conversation', async () => {
    const killed: number[] = []
    const ctx = {
      killTree: async (pid: number) => {
        killed.push(pid)
        fake().finish('c', 1)
      },
      consoleMembers: async () => []
    }
    let made: Awaited<ReturnType<typeof scene>> | null = null
    const fake = () => made!.fake
    made = await scene(ctx)
    const { runner, app, tracker } = made
    await runner.restartOrJoin('c')

    await runner.endAndRestart('c')
    expect(killed).toEqual([4242])
    expect(runner.errors().c).toBeUndefined()
    expect(made.fake.specs).toHaveLength(2)
    expect(made.fake.specs[1].args).toContain('--resume')
    expect(made.fake.specs[1].args).toContain('conv-1')
    expect(app.isRunning('c')).toBe(true)
    expect(tracker.get('c')).toBe('starting')
  })
})

describe('Restart clicked on a node shown as ended, just after a revive', () => {
  test('a revive the runner never heard of: the live session is shown, never ended', async () => {
    const { fake, app, tracker, runner, reattached } = await scene()
    // A focus check reconnects and revives it in the moment before the click lands.
    await app.connect()
    expect(app.isRunning('c')).toBe(true)
    expect(tracker.get('c')).toBe('exited')

    expect(await runner.restartOrJoin('c', { shownExited: true })).toBe('joined')
    expect(fake.specs).toHaveLength(1)
    expect(app.isRunning('c')).toBe(true)
    expect(tracker.get('c')).toBe('unknown')
    expect(reattached).toEqual(['c'])
  })

  test('a revive already taken on: still only shown, and not adopted twice', async () => {
    const { fake, app, tracker, runner, reattached } = await scene()
    app.onRevive((id) => runner.reattachNode(id))
    await app.connect()
    expect(reattached).toEqual(['c'])
    await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit' })

    expect(await runner.restartOrJoin('c', { shownExited: true })).toBe('joined')
    expect(fake.specs).toHaveLength(1)
    expect(reattached).toEqual(['c'])
    // What a hook said since isn't wiped by a second adoption.
    expect(tracker.get('c')).toBe('working')
  })

  test('a Restart on a node the person saw running still restarts it', async () => {
    const { fake, app, runner } = await scene()
    await app.connect()
    expect(await runner.restartOrJoin('c')).toBeUndefined()
    expect(fake.specs).toHaveLength(2)
  })
})
