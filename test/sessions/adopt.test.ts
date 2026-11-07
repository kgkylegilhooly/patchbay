import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { SessionStartError } from '../../src/main/sessions/host'
import { createApprovals } from '../../src/main/sessions/approvals'
import type { MissedHook } from '../../src/main/sessions/missedHooks'
import { createNodeRunner } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasStore, SessionHost } from '../../src/shared/contract'
import type { AgentStatus, CanvasDoc, CanvasNode, ClaudeNode } from '../../src/shared/model'

const claudeNode = (extra: Partial<ClaudeNode> = {}): ClaudeNode =>
  ({ id: 'c', kind: 'claude', title: 'c', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:\\', sessionId: 'old-session', transcriptPath: null, after: [], ...extra }) as ClaudeNode

function setup(nodes: CanvasNode[], missed: MissedHook[] = []) {
  let doc = { version: 2, projects: [], activeProjectId: '', nodes, edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } } as unknown as CanvasDoc
  const store: CanvasStore = {
    get: () => doc,
    dispatch(op) {
      doc = reduce(doc, op)
    },
    subscribe: () => () => {}
  }
  const exits: Array<(id: string, code: number) => void> = []
  const started: string[] = []
  let failure: Error | null = null
  let hold: Promise<void> | null = null
  const host: SessionHost = {
    pid: () => null,
    async start(spec) {
      // As the real one does, this answers later.
      await (hold ?? Promise.resolve())
      if (failure) throw failure
      started.push(spec.nodeId)
    },
    write() {},
    resize() {},
    kill: async () => {},
    isRunning: (id) => started.includes(id),
    snapshot: () => ({ data: '', seq: 0 }),
    onOutput() {},
    onExit: (cb) => void exits.push(cb)
  }
  const notify = vi.fn()
  const tracker = createStatusTracker({ notify })
  const changes: AgentStatus[] = []
  tracker.onChange((_id, s) => changes.push(s))
  const approvals = createApprovals()
  const journal = [...missed]
  const runner = createNodeRunner({
    host,
    tracker,
    store,
    approvals,
    ctx: {
      secret: 's',
      sessionDir: mkdtempSync(join(tmpdir(), 'pb-adopt-')),
      hookScript: 'x',
      pluginDir: 'x',
      cliDir: 'x',
      endpointFile: 'x',
      claude: { file: 'claude.exe', prefixArgs: [] },
      takeMissedHooks: () => journal.splice(0)
    }
  })
  return { store, tracker, runner, notify, changes, exit: (id: string, code: number) => exits.forEach((cb) => cb(id, code)), started, journal, node: () => doc.nodes.find((n) => n.id === 'c') as ClaudeNode, failStart: (e: Error) => void (failure = e), holdStart: () => {
    let release = (): void => {}
    hold = new Promise((r) => (release = r))
    return release
  } }
}

const ev = (hook_event_name: string, extra: Record<string, unknown> = {}): MissedHook => ({ hook_event_name, ...extra })

describe('adopting a Claude node', () => {
  test('its status is unknown, however idle it looked before, and nobody is notified', () => {
    const { tracker, runner, notify, started } = setup([claudeNode()])
    runner.adoptNode('c')
    expect(tracker.get('c')).toBe('unknown')
    expect(tracker.all()).toEqual({ c: 'unknown' })
    expect(notify).not.toHaveBeenCalled()
    expect(started).toEqual([])
  })

  test('live hooks work on it straight away, since the app can now tell', async () => {
    const { tracker, runner } = setup([claudeNode()])
    runner.adoptNode('c')
    await runner.handleHook('c', { hook_event_name: 'PreToolUse' })
    expect(tracker.get('c')).toBe('working')
    await runner.handleHook('c', { hook_event_name: 'Stop' })
    expect(tracker.get('c')).toBe('idle')
    expect(tracker.turnsCompleted('c')).toBe(1)
  })

  test('its exit keeps the conversation, as it was left running rather than failing to resume', async () => {
    const { runner, exit, node, tracker } = setup([claudeNode()])
    runner.adoptNode('c')
    exit('c', 1)
    expect(tracker.get('c')).toBe('exited')
    expect(node().sessionId).toBe('old-session')
    expect(runner.errors()).toEqual({})
  })
})

describe('catching up on hooks from while the app was closed', () => {
  test('an empty journal tells nothing, so unknown stands', () => {
    const { tracker, runner } = setup([claudeNode()])
    runner.adoptNode('c')
    runner.catchUpHooks('c')
    expect(tracker.get('c')).toBe('unknown')
  })

  test('a finished turn reads as idle and counts, for a node waiting on it, without a stale notification', () => {
    const { tracker, runner, notify } = setup([claudeNode()], [ev('PreToolUse'), ev('Stop')])
    runner.adoptNode('c')
    runner.catchUpHooks('c')
    expect(tracker.get('c')).toBe('idle')
    expect(tracker.turnsCompleted('c')).toBe(1)
    expect(notify).not.toHaveBeenCalled()
  })

  test('a permission request reads as needing you, with no button that could not answer it', () => {
    const { tracker, runner } = setup([claudeNode()], [ev('PermissionRequest')])
    runner.adoptNode('c')
    runner.catchUpHooks('c')
    expect(tracker.get('c')).toBe('needs-you')
  })

  test('a new session id from /clear is kept, so resume finds the right conversation later', () => {
    const { runner, node } = setup([claudeNode()], [ev('SessionStart', { session_id: 'new', transcript_path: 'n.jsonl', source: 'clear' })])
    runner.adoptNode('c')
    runner.catchUpHooks('c')
    expect(node().sessionId).toBe('new')
    expect(node().transcriptPath).toBe('n.jsonl')
  })

  test('a starting prompt that was submitted while closed is not kept to run again', () => {
    const { runner, node } = setup([claudeNode({ prompt: 'do it' })], [ev('UserPromptSubmit')])
    runner.adoptNode('c')
    runner.catchUpHooks('c')
    expect(node().prompt).toBeUndefined()
  })

  test('once a live hook has been heard, a late journal entry is older news and is dropped', async () => {
    const { tracker, runner, journal } = setup([claudeNode()])
    runner.adoptNode('c')
    await runner.handleHook('c', { hook_event_name: 'PreToolUse' })
    journal.push(ev('Stop'))
    runner.catchUpHooks('c')
    expect(tracker.get('c')).toBe('working')
    expect(journal).toEqual([])
  })

  test('a fresh launch throws away a journal from the process before it', async () => {
    const { runner, journal, tracker } = setup([claudeNode()], [ev('Stop')])
    await runner.startNode('c')
    expect(journal).toEqual([])
    expect(tracker.get('c')).toBe('starting')
  })
})

describe('adopting other nodes', () => {
  const run = { id: 'r', kind: 'run', title: 'r', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:\\', command: 'x' } as unknown as CanvasNode

  test('a run node reads as running', () => {
    const { runner } = setup([run])
    runner.adoptNode('r')
    expect(runner.runs().r).toMatchObject({ running: true, exitCode: null })
  })

  test('a run node that ended while away reports how', () => {
    const { runner } = setup([run])
    runner.noteFinishedRun('r', 3, 1234)
    expect(runner.runs().r).toEqual({ running: false, exitCode: 3, stoppedByYou: false, at: 1234 })
  })

  test('a node that has since gone is ignored', () => {
    const { runner, tracker } = setup([])
    runner.adoptNode('nobody')
    expect(tracker.all()).toEqual({})
  })
})

test('a start that fails after waiting on the host stores no session, so nothing later tries to resume it', async () => {
  const { runner, node, tracker, failStart } = setup([claudeNode({ sessionId: null })])
  failStart(new SessionStartError('spawn-failed', 'The session host went away.'))
  await runner.startNode('c')
  expect(node().sessionId).toBeNull()
  expect(tracker.get('c')).toBe('exited')
  expect(runner.errors().c).toEqual({ code: 'spawn-failed', message: 'The session host went away.' })
})

test('a hook that beats the host\'s answer to the start is still heard', async () => {
  const { runner, tracker, holdStart } = setup([claudeNode({ sessionId: null })])
  const release = holdStart()
  const starting = runner.startNode('c')
  await new Promise((r) => setTimeout(r, 0))
  await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 'early' })
  expect(tracker.get('c')).toBe('idle')
  release()
  await starting
})
