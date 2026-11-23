import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { tokenFor } from '../../src/main/control/server'
import { createSessionHost, SessionStartError } from '../../src/main/sessions/host'
import { consolesFull, CONSOLES_FULL, createNodeRunner, type NodeRunnerContext } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasStore, NodeError, SessionHost, SessionSpec } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, ClaudeNode, TerminalNode } from '../../src/shared/model'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay runner '))
})

afterEach(() => {
  vi.restoreAllMocks()
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

interface FakeHost extends SessionHost {
  specs: SessionSpec[]
  exit(id: string, code: number): void
  failNext(e: Error): void
  /** Output from a session, as the program would print it. */
  emit(id: string, data: string): void
  /** What a snapshot of any session holds. */
  screen: { data: string }
}

/** Records what would run. A test decides when a session exits and with what code. */
function fakeHost(): FakeHost {
  const running = new Set<string>()
  const exits: Array<(id: string, code: number) => void> = []
  const outputs: Array<(id: string, data: string, seq: number) => void> = []
  const specs: SessionSpec[] = []
  let failure: Error | null = null
  const screen = { data: 'SCROLLBACK' }
  const exit = (id: string, code: number): void => {
    if (!running.delete(id)) return
    for (const cb of exits) cb(id, code)
  }
  return {
    pid: () => null,
    specs,
    exit,
    emit(id, data) {
      for (const cb of outputs) cb(id, data, 0)
    },
    failNext(e) {
      failure = e
    },
    start(spec) {
      if (failure) {
        const e = failure
        failure = null
        throw e
      }
      specs.push(spec)
      running.add(spec.nodeId)
    },
    write() {},
    resize() {},
    async kill(id) {
      exit(id, -1)
    },
    isRunning: (id) => running.has(id),
    screen,
    snapshot: () => ({ data: screen.data, seq: 1 }),
    onOutput(cb) {
      outputs.push(cb)
    },
    onExit(cb) {
      exits.push(cb)
    }
  }
}

const claude = (over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id: 'c',
  kind: 'claude',
  title: 'Claude',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  parentId: null,
  cwd: dir,
  sessionId: null,
  transcriptPath: null,
  after: [],
  ...over
})

const terminal = (over: Partial<TerminalNode> = {}): TerminalNode => ({
  id: 't',
  kind: 'terminal',
  title: 'Shell',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  parentId: null,
  cwd: dir,
  ...over
})

const ctx = (over: Partial<NodeRunnerContext> = {}): NodeRunnerContext => ({
  sessionDir: join(dir, 'sessions'),
  hookScript: 'C:/hook.cjs',
  pluginDir: 'C:/skill',
  cliDir: 'C:/cli',
  endpointFile: 'C:/endpoint.json',
  secret: 'sec',
  claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
  baseEnv: { PATH: 'C:\\Windows' },
  ...over
})

function setup(nodes: CanvasNode[], over: Partial<NodeRunnerContext> = {}, host: SessionHost = fakeHost()) {
  const store = memoryStore(nodes)
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = createNodeRunner({ host, tracker, store, ctx: ctx(over) })
  const node = <T extends CanvasNode = ClaudeNode>(id: string): T => store.get().nodes.find((n) => n.id === id) as T
  return { store, tracker, runner, host: host as FakeHost, node }
}

test('starting a new Claude node launches it with hooks, stores its uuid and reads starting', async () => {
  const { runner, host, tracker, node } = setup([claude({ prompt: 'hello' })])
  await runner.startNode('c')
  expect(host.specs).toHaveLength(1)
  const spec = host.specs[0]
  expect(spec.file).toBe('C:\\bin\\claude.exe')
  expect(spec.env.PATCHBAY_TOKEN).toBe(tokenFor('sec', 'c'))
  expect(spec.args.slice(-2)).toEqual(['--', 'hello'])
  expect(node('c').sessionId).toBe(spec.args[spec.args.indexOf('--session-id') + 1])
  expect(tracker.get('c')).toBe('starting')
})

test('starting a node that is already running changes nothing', async () => {
  const { runner, host } = setup([claude()])
  await runner.startNode('c')
  await runner.startNode('c')
  expect(host.specs).toHaveLength(1)
})

test('starting a missing node, sticky or group does nothing', async () => {
  const { runner, host } = setup([
    { id: 's', kind: 'sticky', title: '', x: 0, y: 0, width: 1, height: 1, parentId: null, text: '' }
  ])
  await runner.startNode('s')
  await runner.startNode('ghost')
  expect(host.specs).toHaveLength(0)
})

test('a SessionStart hook updates sessionId and transcriptPath on the node', async () => {
  const { runner, node, tracker } = setup([claude()])
  await runner.startNode('c')
  await runner.handleHook('c', {
    hook_event_name: 'SessionStart',
    source: 'clear',
    session_id: 'new-id',
    transcript_path: 'C:\\t\\new-id.jsonl'
  })
  expect(node('c').sessionId).toBe('new-id')
  expect(node('c').transcriptPath).toBe('C:\\t\\new-id.jsonl')
  expect(tracker.get('c')).toBe('idle')
})

describe('a lost SessionStart: the session is learned from the hooks that do come', () => {
  test('any hook of the session fills in a transcript Patchbay never heard of', async () => {
    // Started with --session-id, so the id is known, but the SessionStart that names the transcript never arrived.
    const { runner, node } = setup([claude({ sessionId: 'sid', transcriptPath: null })])
    await runner.startNode('c')
    await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit', session_id: 'sid', transcript_path: 'C:\\t\\sid.jsonl' })
    expect(node('c').transcriptPath).toBe('C:\\t\\sid.jsonl')
    expect(node('c').sessionId).toBe('sid')
  })

  test('a session taken on with none recorded at all: its first hook records it', async () => {
    // A launch always names the session (--session-id); one found running in the host may have nothing on record.
    const { runner, node } = setup([claude({ sessionId: null, transcriptPath: null })])
    runner.adoptNode('c')
    await runner.handleHook('c', { hook_event_name: 'PostToolUse', session_id: 'learned', transcript_path: 'C:\\t\\learned.jsonl' })
    expect(node('c')).toMatchObject({ sessionId: 'learned', transcriptPath: 'C:\\t\\learned.jsonl' })
  })

  test("a turn of a newer conversation (a /clear whose SessionStart was lost) moves the node to it", async () => {
    const { runner, node } = setup([claude({ sessionId: 'old', transcriptPath: 'C:\\t\\old.jsonl' })])
    await runner.startNode('c')
    await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit', session_id: 'new', transcript_path: 'C:\\t\\new.jsonl' })
    expect(node('c')).toMatchObject({ sessionId: 'new', transcriptPath: 'C:\\t\\new.jsonl' })
  })

  test('tool calls and subagents never move a recorded session: they can belong to a subagent', async () => {
    const { runner, node } = setup([claude({ sessionId: 'main', transcriptPath: 'C:\\t\\main.jsonl' })])
    await runner.startNode('c')
    for (const name of ['PostToolUse', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest', 'SessionEnd']) {
      await runner.handleHook('c', { hook_event_name: name, session_id: 'other', transcript_path: 'C:\\t\\other.jsonl' })
    }
    expect(node('c')).toMatchObject({ sessionId: 'main', transcriptPath: 'C:\\t\\main.jsonl' })
  })

  test("a Codex window's hooks can be a child thread's, so only its SessionStart sets the session", async () => {
    const { runner, node } = setup([claude({ agent: 'codex', sessionId: 'thread', transcriptPath: 'C:\\t\\rollout.jsonl' })])
    await runner.startNode('c')
    await runner.handleHook('c', { hook_event_name: 'Stop', session_id: 'child', transcript_path: 'C:\\t\\child.jsonl' })
    expect(node('c')).toMatchObject({ sessionId: 'thread', transcriptPath: 'C:\\t\\rollout.jsonl' })
  })
})

test('a SessionEnd hook never changes the stored session', async () => {
  const { runner, node } = setup([claude({ sessionId: 'good' })])
  await runner.startNode('c')
  await runner.handleHook('c', { hook_event_name: 'SessionEnd', reason: 'other', session_id: 'bad' })
  expect(node('c').sessionId).toBe('good')
})

test('hooks drive the status, with notification type and end reason passed along', async () => {
  const { runner, tracker } = setup([claude()])
  await runner.startNode('c')
  await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit' })
  expect(tracker.get('c')).toBe('working')
  await runner.handleHook('c', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
  expect(tracker.get('c')).toBe('needs-you')
  await runner.handleHook('c', { hook_event_name: 'SessionEnd', reason: 'clear' })
  expect(tracker.get('c')).toBe('needs-you')
  await runner.handleHook('c', { hook_event_name: 'SessionEnd', reason: 'other' })
  expect(tracker.get('c')).toBe('exited')
})

test('a Claude at its folder-trust question needs the person; ordinary startup output does not', async () => {
  const { runner, host, tracker } = setup([claude(), claude({ id: 'd' })])
  await runner.startNode('c')
  await runner.startNode('d')
  host.emit('d', 'Welcome to Claude Code\r\n')
  host.emit('c', 'Quick safety check: Is this a project you created or one you trust?\r\n 1. Yes, I trust this folder')
  expect(tracker.get('c')).toBe('needs-you')
  expect(tracker.get('d')).toBe('starting')
})

test('a Claude Patchbay call through the MCP tool name is not let through: only Codex uses it', async () => {
  const approvals = { request: vi.fn(async () => 'allow' as const), clearNode: vi.fn(), pending: () => [] }
  const store = memoryStore([claude()])
  const runner = createNodeRunner({ host: fakeHost(), tracker: createStatusTracker({ notify: () => {} }), store, approvals: approvals as never, ctx: ctx() })
  await runner.startNode('c')
  await runner.handleHook('c', { hook_event_name: 'PermissionRequest', tool_name: 'mcp__patchbay__patchbay', tool_input: { args: ['whoami'] } })
  expect(approvals.request).toHaveBeenCalledTimes(1)
})

test('a hook from a node with no running Claude is ignored', async () => {
  const { runner, tracker, node } = setup([terminal(), claude()])
  await runner.handleHook('t', { hook_event_name: 'Stop' })
  await runner.handleHook('ghost', { hook_event_name: 'Stop' })
  await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 'x' })
  expect(tracker.all()).toEqual({})
  expect(node('c').sessionId).toBeNull()
})

test('noteInput sends an interrupt for a lone Esc or anything containing Ctrl+C', async () => {
  const { runner, tracker } = setup([claude({ sessionId: 's' })])
  await runner.startNode('c')
  const toWorking = () => runner.handleHook('c', { hook_event_name: 'UserPromptSubmit' })

  await toWorking()
  runner.noteInput('c', 'plain text')
  runner.noteInput('c', '\x1b[A') // an arrow key starts with Esc but isn't one
  expect(tracker.get('c')).toBe('working')

  runner.noteInput('c', '\x1b')
  expect(tracker.get('c')).toBe('unknown')

  await toWorking()
  runner.noteInput('c', 'ab\x03cd')
  expect(tracker.get('c')).toBe('unknown')
})

test('noteInput on a plain terminal does not create a status', async () => {
  const { runner, tracker } = setup([terminal()])
  await runner.startNode('t')
  runner.noteInput('t', '\x03')
  expect(tracker.all()).toEqual({})
})

test('startNode with a deleted cwd: status exited, error surfaced, no throw', async () => {
  const gone = join(dir, 'deleted')
  const { runner, tracker, node } = setup([claude({ cwd: gone })], {}, createSessionHost())
  const seen: Array<[string, NodeError | null]> = []
  runner.onError((id, e) => seen.push([id, e]))
  await expect(runner.startNode('c')).resolves.toBeUndefined()
  expect(tracker.get('c')).toBe('exited')
  expect(runner.errors().c?.code).toBe('cwd-missing')
  expect(runner.errors().c?.message).toContain(gone)
  expect(seen.map(([id, e]) => [id, e?.code])).toEqual([['c', 'cwd-missing']])
  expect(node('c').sessionId).toBeNull()
})

test('a spawn failure surfaces spawn-failed and leaves other nodes startable', async () => {
  const { runner, host } = setup([claude(), terminal()])
  host.failNext(new SessionStartError('spawn-failed', 'nope'))
  await runner.startNode('c')
  expect(runner.errors().c).toEqual({ code: 'spawn-failed', message: 'nope' })
  await runner.startNode('t')
  expect(host.isRunning('t')).toBe(true)
})

test('an unexpected launch error is also surfaced rather than thrown', async () => {
  const { runner, host } = setup([claude()])
  host.failNext(new Error('boom'))
  await runner.startNode('c')
  expect(runner.errors().c?.code).toBe('spawn-failed')
})

test('a missing claude executable is surfaced as spawn-failed', async () => {
  const { runner } = setup([claude()], {
    claude: undefined,
    locateClaude: () => {
      throw new Error('claude was not found on PATH')
    }
  })
  await runner.startNode('c')
  expect(runner.errors().c).toEqual({ code: 'spawn-failed', message: 'claude was not found on PATH' })
})

test('a resumed Claude that exits within 5 s with nonzero code surfaces resume-failed', async () => {
  const { runner, host, tracker } = setup([claude({ sessionId: 'gone' })])
  await runner.startNode('c')
  host.exit('c', 1)
  expect(runner.errors().c?.code).toBe('resume-failed')
  expect(tracker.get('c')).toBe('exited')
})

describe('Codex', () => {
  const codexCtx = { codex: { file: 'C:\\bin\\codex.exe', prefixArgs: [] } }


  test('stopped at its folder-trust question, it needs the person, and starts once past it', async () => {
    const { runner, host, tracker } = setup([claude({ agent: 'codex', prompt: 'hi' })], codexCtx)
    await runner.startNode('c')
    // Drawn with cursor moves rather than spaces, as a full-screen program does.
    host.emit('c', '\x1b[2J\x1b[1;1HFolder access\x1b[3;3HTrust\x1b[3;9Hthis\x1b[3;14Hfolder?')
    expect(tracker.get('c')).toBe('needs-you')
    await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 'cx-1' })
    expect(tracker.get('c')).toBe('idle')
    // Later output that happens to mention trust changes nothing.
    host.emit('c', 'Do you trust the files in this folder?')
    expect(tracker.get('c')).toBe('idle')
  })

  test('its read-only Patchbay calls go ahead without asking; the rest still ask', async () => {
    const approvals = { request: vi.fn(async () => 'deny' as const), clearNode: vi.fn(), pending: () => [] }
    const store = memoryStore([claude({ agent: 'codex', prompt: 'hi' })])
    const tracker = createStatusTracker({ notify: () => {} })
    const runner = createNodeRunner({ host: fakeHost(), tracker, store, approvals: approvals as never, ctx: ctx(codexCtx) })
    await runner.startNode('c')
    await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit' })
    const ask = (args: string[]) => runner.handleHook('c', { hook_event_name: 'PermissionRequest', tool_name: 'mcp__patchbay__patchbay', tool_input: { args } })
    expect(await ask(['whoami'])).toEqual({ decision: 'allow' })
    expect(await ask(['guide'])).toEqual({ decision: 'allow' })
    expect(tracker.get('c')).toBe('working')
    expect(approvals.request).not.toHaveBeenCalled()
    expect(await ask(['send', '--node', 'x', '--text', 'hi'])).toEqual({ decision: 'deny' })
    expect(approvals.request).toHaveBeenCalledTimes(1)
  })

  test('a new Codex runs codex with the hooks, and takes its session id from SessionStart', async () => {
    const { runner, host, store, tracker } = setup([claude({ agent: 'codex', prompt: 'hi' })], codexCtx)
    await runner.startNode('c')
    expect(host.specs[0].file).toBe('C:\\bin\\codex.exe')
    expect(host.specs[0].args.some((a) => a.startsWith('hooks.Stop='))).toBe(true)
    // Codex picks the id, so none is invented at launch.
    expect((store.get().nodes[0] as ClaudeNode).sessionId).toBeNull()
    await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 'cx-1', transcript_path: 'C:\\r.jsonl' })
    expect(store.get().nodes[0]).toMatchObject({ sessionId: 'cx-1', transcriptPath: 'C:\\r.jsonl' })
    expect(tracker.get('c')).toBe('idle')
  })

  test('a resumed Codex sends no SessionStart, so it reads as ready once past the failed-resume window', async () => {
    vi.useFakeTimers()
    try {
      const { runner, host, tracker } = setup([claude({ agent: 'codex', sessionId: 'cx-1' })], codexCtx)
      await runner.startNode('c')
      expect(host.specs[0].args[0]).toBe('resume')
      expect(tracker.get('c')).toBe('starting')
      vi.advanceTimersByTime(5000)
      expect(tracker.get('c')).toBe('idle')
      host.exit('c', 1)
      expect(runner.errors().c).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a resumed Codex that dies at once is a failed resume, named as Codex', async () => {
    const { runner, host } = setup([claude({ agent: 'codex', sessionId: 'gone' })], codexCtx)
    await runner.startNode('c')
    host.exit('c', 1)
    expect(runner.errors().c?.message).toMatch(/^Codex could not reopen/)
  })
})

test('a resumed Claude that exits later, cleanly or after SessionStart is not a failed resume', async () => {
  const quick = setup([claude({ sessionId: 's' })])
  await quick.runner.startNode('c')
  quick.host.exit('c', 0)
  expect(quick.runner.errors().c).toBeUndefined()

  const started = setup([claude({ sessionId: 's' })])
  await started.runner.startNode('c')
  await started.runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 's' })
  started.host.exit('c', 1)
  expect(started.runner.errors().c).toBeUndefined()

  const slow = setup([claude({ sessionId: 's' })])
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  await slow.runner.startNode('c')
  now.mockReturnValue(1000 + 5001)
  slow.host.exit('c', 1)
  expect(slow.runner.errors().c).toBeUndefined()
})

test('a new Claude that exits nonzero, or a resume killed by stopAll, is not a failed resume', async () => {
  const fresh = setup([claude()])
  await fresh.runner.startNode('c')
  fresh.host.exit('c', 1)
  expect(fresh.runner.errors().c).toBeUndefined()

  const killed = setup([claude({ sessionId: 's' })])
  await killed.runner.startNode('c')
  await killed.runner.stopAll()
  expect(killed.runner.errors().c).toBeUndefined()
  expect(killed.tracker.get('c')).toBe('exited')
  expect(killed.host.isRunning('c')).toBe(false)
})

test('restart after a failed resume with no transcript starts a new conversation and clears the error', async () => {
  const { runner, host, node } = setup([claude({ sessionId: 'gone', transcriptPath: join(dir, 'gone.jsonl') })])
  const seen: Array<NodeError | null> = []
  runner.onError((_id, e) => seen.push(e))
  await runner.startNode('c')
  host.exit('c', 1)
  await runner.restartNode('c')
  expect(runner.errors().c).toBeUndefined()
  expect(seen.map((e) => e?.code ?? null)).toEqual(['resume-failed', null])
  const spec = host.specs[1]
  expect(spec.args).toContain('--session-id')
  expect(spec.args).not.toContain('--resume')
  expect(node('c').sessionId).toBe(spec.args[spec.args.indexOf('--session-id') + 1])
})

test('restart after a failed resume keeps the conversation while its transcript still exists', async () => {
  const transcript = join(dir, 'kept.jsonl')
  writeFileSync(transcript, '{}\n')
  const { runner, host, node } = setup([claude({ sessionId: 'kept', transcriptPath: transcript })])
  await runner.startNode('c')
  host.exit('c', 1)
  await runner.restartNode('c')
  expect(host.specs[1].args).toContain('--resume')
  expect(node('c').sessionId).toBe('kept')
})

test('restart of a running Claude kills it first, resumes it and raises no false error', async () => {
  const { runner, host, tracker } = setup([claude({ sessionId: 's' })])
  await runner.startNode('c')
  await runner.restartNode('c')
  expect(host.specs).toHaveLength(2)
  expect(host.specs[1].args).toContain('--resume')
  expect(runner.errors().c).toBeUndefined()
  expect(tracker.get('c')).toBe('starting')
})

test('a Claude closed before any prompt forgets its session, so reopening does not fail on resume', async () => {
  const { runner, host, node } = setup([claude()])
  await runner.startNode('c')
  await runner.handleHook('c', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'u', transcript_path: 'p' })
  host.exit('c', 0)
  expect(node('c').sessionId).toBeNull()
  expect(node('c').transcriptPath).toBeNull()
})

test('a Claude that took a prompt keeps its session after exit', async () => {
  const { runner, host, node } = setup([claude()])
  await runner.startNode('c')
  await runner.handleHook('c', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'u', transcript_path: 'p' })
  await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit' })
  host.exit('c', 0)
  expect(node('c').sessionId).toBe('u')
})

test('a Claude left empty by /clear forgets the new session, but one that resumed keeps it', async () => {
  const cleared = setup([claude({ sessionId: 'old' })])
  await cleared.runner.startNode('c')
  await cleared.runner.handleHook('c', { hook_event_name: 'SessionStart', source: 'clear', session_id: 'new' })
  cleared.host.exit('c', 0)
  expect(cleared.node('c').sessionId).toBeNull()

  const resumed = setup([claude({ sessionId: 'old' })])
  await resumed.runner.startNode('c')
  await resumed.runner.handleHook('c', { hook_event_name: 'SessionStart', source: 'resume', session_id: 'old' })
  resumed.host.exit('c', 0)
  expect(resumed.node('c').sessionId).toBe('old')
})

test('a terminal starts the default shell in its folder with Patchbay env and no status', async () => {
  const { runner, host, tracker } = setup([terminal()], { shell: 'C:\\tools\\nu.exe' })
  await runner.startNode('t')
  const spec = host.specs[0]
  expect(spec).toMatchObject({ file: 'C:\\tools\\nu.exe', args: [], cwd: dir })
  expect(spec.env.PATCHBAY_NODE_ID).toBe('t')
  expect(spec.env.PATCHBAY_TOKEN).toBe(tokenFor('sec', 't'))
  expect(spec.env.PATH.startsWith('C:/cli')).toBe(true)
  host.exit('t', 0)
  expect(tracker.all()).toEqual({})
})

test.each([
  ['C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i', '-c', 'codex "a b"\nexec bash --login -i']],
  ['powershell.exe', ['-NoExit', '-Command', 'codex "a b"']],
  ['C:\\Windows\\System32\\cmd.exe', ['/k', 'codex "a b"']],
  ['C:\\tools\\zsh.exe', ['-c', 'codex "a b"']]
])('a terminal with a custom command runs it through %s', async (shell, args) => {
  const { runner, host } = setup([terminal({ command: 'codex "a b"' })], { shell })
  await runner.startNode('t')
  expect(host.specs[0].args).toEqual(args)
})

test('startNode passes saved scrollback to the session', async () => {
  const { runner, host } = setup([terminal()])
  await runner.startNode('t', { initialScrollback: 'old\r\n' })
  expect(host.specs[0].initialScrollback).toBe('old\r\n')
})

test('restarting a terminal keeps its scrollback; restarting Claude does not replay it', async () => {
  const t = setup([terminal()])
  await t.runner.startNode('t')
  await t.runner.restartNode('t')
  expect(t.host.specs[1].initialScrollback).toBe('SCROLLBACK')

  const c = setup([claude({ sessionId: 's' })])
  await c.runner.startNode('c')
  await c.runner.restartNode('c')
  expect(c.host.specs[1].initialScrollback).toBeUndefined()
})

test('stopAll kills every running session', async () => {
  const { runner, host } = setup([claude(), terminal()])
  await runner.startNode('c')
  await runner.startNode('t')
  await runner.stopAll()
  expect(host.isRunning('c')).toBe(false)
  expect(host.isRunning('t')).toBe(false)
})

test('stopNode ends a session on purpose: no false resume error, and any old error goes', async () => {
  const { runner, host, tracker } = setup([claude({ sessionId: 's' })])
  await runner.startNode('c')
  await runner.stopNode('c')
  expect(host.isRunning('c')).toBe(false)
  expect(tracker.get('c')).toBe('exited')
  expect(runner.errors().c).toBeUndefined()

  await runner.startNode('c')
  host.exit('c', 1)
  expect(runner.errors().c?.code).toBe('resume-failed')
  await runner.stopNode('c')
  expect(runner.errors().c).toBeUndefined()
})

describe('a prompt through a custom terminal', () => {
  const custom = { settings: () => ({ claudeTerminal: 'cmd.exe' }) }

  test('stays off the command line, where a shell could run it', async () => {
    const { runner, host } = setup([claude({ prompt: 'x&calc' })], custom)
    await runner.startNode('c')
    expect(JSON.stringify(host.specs[0].args)).not.toContain('calc')
  })

  test('is typed once Claude is ready, as one paste so a long one keeps its start, then submitted separately, and only once', async () => {
    vi.useFakeTimers()
    const { runner, host } = setup([claude({ prompt: 'x&calc' })], custom)
    const write = vi.spyOn(host, 'write')
    await runner.startNode('c')
    expect(write).not.toHaveBeenCalled()
    await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(write).toHaveBeenCalledWith('c', '\x1b[200~x&calc\x1b[201~')
    expect(write).toHaveBeenLastCalledWith('c', '\r')
    write.mockClear()
    await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 's', source: 'clear' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(write).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  test('has control characters removed, so it cannot press keys', async () => {
    vi.useFakeTimers()
    const { runner, host } = setup([claude({ prompt: 'a\x1b[Bb\x03c\nd' })], custom)
    const write = vi.spyOn(host, 'write')
    await runner.startNode('c')
    await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(write.mock.calls[0][1]).toBe('\x1b[200~a[Bbc d\x1b[201~')
    vi.useRealTimers()
  })

  test('the normal launch still passes it on the command line', async () => {
    const { runner, host } = setup([claude({ prompt: 'hello' })])
    await runner.startNode('c')
    expect(host.specs[0].args.at(-1)).toBe('hello')
  })
})

test('a prompt that has been submitted is not sent again after /clear and a relaunch', async () => {
  const { runner, host, node } = setup([claude({ prompt: 'do the thing' })])
  await runner.startNode('c')
  await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' })
  await runner.handleHook('c', { hook_event_name: 'UserPromptSubmit', session_id: 's' })
  expect(node('c').prompt).toBeUndefined()
  await runner.handleHook('c', { hook_event_name: 'SessionStart', session_id: 's2', source: 'clear' })
  await runner.restartNode('c')
  expect(JSON.stringify(host.specs.at(-1)?.args)).not.toContain('do the thing')
})

test('a restored terminal is a fresh shell, and does not run its command by itself', async () => {
  const { runner, host } = setup([terminal({ command: 'npm run deploy' })], { shell: 'cmd.exe' })
  await runner.startNode('t', { restored: true })
  expect(JSON.stringify(host.specs[0].args)).not.toContain('deploy')
})

describe('SSH terminals', () => {
  const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'

  test('run the system ssh to the host, with no shell in between', async () => {
    const { runner, host } = setup([terminal({ sshHost: 'me@build-box' })], { shell: 'cmd.exe', ssh: () => SSH })
    await runner.startNode('t')
    expect(host.specs[0].file).toBe(SSH)
    expect(host.specs[0].args).toEqual(['--', 'me@build-box'])
  })

  test('connect again when restored, since a login runs nothing by itself', async () => {
    const { runner, host } = setup([terminal({ sshHost: 'build-box' })], { ssh: () => SSH })
    await runner.startNode('t', { restored: true })
    expect(host.specs[0].args).toEqual(['--', 'build-box'])
  })

  test('refuse a host that ssh would read as an option, and start nothing', async () => {
    const errors: NodeError[] = []
    const { runner, host } = setup([terminal({ sshHost: '-oProxyCommand=calc' })], { ssh: () => SSH })
    runner.onError((_id, e) => e && errors.push(e))
    await runner.startNode('t')
    expect(host.specs).toEqual([])
    expect(errors[0]?.message).toMatch(/isn’t a host name/)
  })

  test('say so when ssh is not installed', async () => {
    const errors: NodeError[] = []
    const { runner, host } = setup([terminal({ sshHost: 'build-box' })], { ssh: () => null })
    runner.onError((_id, e) => e && errors.push(e))
    await runner.startNode('t')
    expect(host.specs).toEqual([])
    expect(errors[0]?.message).toMatch(/OpenSSH/)
  })
})

test('a terminal opened or restarted by hand still runs its command', async () => {
  const { runner, host } = setup([terminal({ command: 'npm test' })], { shell: 'cmd.exe' })
  await runner.startNode('t')
  expect(JSON.stringify(host.specs[0].args)).toContain('npm test')
})

describe("Git Bash's limit on consoles", () => {
  const dump =
    '      0 [main] bash 52684 C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe: *** fatal error - console device allocation failure - too many consoles in use, max consoles is 32\r\n    375 [main] bash 52684 cygwin_exception::open_stackdumpfile: Dumping stack trace to bash.exe.stackdump\r\n'

  test('a terminal that dies of it says why, and what to do', async () => {
    const { runner, host } = setup([terminal()])
    await runner.startNode('t')
    host.screen.data = `\x1b]0;C:\\Program Files\\Git\\bin\\bash.exe\x07${dump}`
    host.exit('t', 1)
    expect(runner.errors().t).toEqual({ code: 'spawn-failed', message: CONSOLES_FULL })
    // Restarting clears it.
    host.screen.data = ''
    await runner.startNode('t')
    expect(runner.errors().t).toBeUndefined()
  })

  test('a terminal that ends any other way, or one that only mentions it long ago, gets no such message', async () => {
    const { runner, host } = setup([terminal()])
    await runner.startNode('t')
    host.screen.data = 'exit\r\n'
    host.exit('t', 1)
    expect(runner.errors().t).toBeUndefined()
    expect(consolesFull(dump + 'x'.repeat(5000))).toBe(false)
    expect(consolesFull(dump)).toBe(true)
  })
})
