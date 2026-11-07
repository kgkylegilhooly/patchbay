import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { createApprovals } from '../../src/main/sessions/approvals'
import { buildClaudeLaunch } from '../../src/main/sessions/claudeLaunch'
import { createNodeRunner } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createEchoSessionHost } from '../../src/main/stubs'
import type { CanvasStore, PendingApproval } from '../../src/shared/contract'
import type { CanvasDoc, ClaudeNode } from '../../src/shared/model'

const bash = (command = 'ls -la'): Record<string, unknown> => ({ tool_name: 'Bash', tool_input: { command } })
const onlyPending = (a: ReturnType<typeof createApprovals>): PendingApproval => {
  expect(a.pending()).toHaveLength(1)
  return a.pending()[0]
}

test('an ordinary tool request is pending until answered; answer resolves it', async () => {
  const a = createApprovals()
  const result = a.request('n', bash())
  const p = onlyPending(a)
  expect(p).toMatchObject({ nodeId: 'n', tool: 'Bash', summary: 'ls -la' })
  a.answer(p.requestId, 'allow')
  await expect(result).resolves.toBe('allow')
  expect(a.pending()).toEqual([])

  const denied = a.request('n', bash())
  a.answer(onlyPending(a).requestId, 'deny')
  await expect(denied).resolves.toBe('deny')
})

test('the hold timeout resolves null and clears the buttons', async () => {
  const a = createApprovals({ holdMs: 20 })
  const seen: number[] = []
  a.onChange((list) => seen.push(list.length))
  const result = a.request('n', bash())
  expect(a.pending()).toHaveLength(1)
  await expect(result).resolves.toBeNull()
  expect(a.pending()).toEqual([])
  expect(seen).toEqual([1, 0])
})

test.each([
  ['AskUserQuestion', { questions: [] }],
  ['ExitPlanMode', { plan: 'x' }]
])('question and plan-approval requests resolve null at once and never appear as pending: %s', async (tool_name, tool_input) => {
  const a = createApprovals()
  const seen = vi.fn()
  a.onChange(seen)
  await expect(a.request('n', { tool_name, tool_input })).resolves.toBeNull()
  expect(a.pending()).toEqual([])
  expect(seen).not.toHaveBeenCalled()
})

test('a request whose input was withheld as too large gets no buttons, so nobody approves it unseen', async () => {
  const a = createApprovals()
  await expect(a.request('n', { tool_name: 'Write' })).resolves.toBeNull()
  expect(a.pending()).toEqual([])
})

test('an MCP tool stays answerable', () => {
  const a = createApprovals()
  void a.request('n', { tool_name: 'mcp__x__do', tool_input: { a: 1 } })
  expect(onlyPending(a)).toMatchObject({ tool: 'mcp__x__do', summary: '{"a":1}' })
  a.clearNode('n')
})

test('answering a cleared request is a harmless no-op', async () => {
  const a = createApprovals()
  const result = a.request('n', bash())
  const { requestId } = onlyPending(a)
  a.clearNode('n')
  await expect(result).resolves.toBeNull()
  const seen = vi.fn()
  a.onChange(seen)
  expect(() => a.answer(requestId, 'allow')).not.toThrow()
  expect(() => a.answer('never-existed', 'deny')).not.toThrow()
  a.clearNode('n')
  expect(seen).not.toHaveBeenCalled()
})

test('a decision other than allow or deny is ignored', () => {
  const a = createApprovals()
  void a.request('n', bash())
  a.answer(onlyPending(a).requestId, 'yes' as 'allow')
  expect(a.pending()).toHaveLength(1)
  a.clearNode('n')
})

test('clearNode leaves other nodes pending', async () => {
  const a = createApprovals()
  void a.request('one', bash())
  const two = a.request('two', bash())
  a.clearNode('one')
  expect(onlyPending(a).nodeId).toBe('two')
  a.answer(onlyPending(a).requestId, 'allow')
  await expect(two).resolves.toBe('allow')
})

test('an aborted signal resolves null and clears the request', async () => {
  const a = createApprovals()
  const controller = new AbortController()
  const result = a.request('n', bash(), controller.signal)
  controller.abort()
  await expect(result).resolves.toBeNull()
  expect(a.pending()).toEqual([])
})

test.each([
  ['Bash', { command: 'npm test' }, 'npm test'],
  ['Read', { file_path: 'C:/a.txt' }, 'C:/a.txt'],
  ['Write', { file_path: 'C:/b.txt', content: 'long' }, 'C:/b.txt'],
  ['WebFetch', { url: 'https://x.test', prompt: 'p' }, 'https://x.test']
])('the summary for %s comes from its main input', (tool_name, tool_input, summary) => {
  const a = createApprovals()
  void a.request('n', { tool_name, tool_input })
  expect(onlyPending(a).summary).toBe(summary)
  a.clearNode('n')
})

test('the summary stays under 200 characters and is marked when cut', () => {
  const a = createApprovals()
  void a.request('n', bash('x'.repeat(5000)))
  const { summary } = onlyPending(a)
  expect(summary.length).toBeLessThan(200)
  expect(summary.endsWith('…')).toBe(true)
  a.clearNode('n')
})

test('the summary collapses whitespace and control characters, so padding cannot hide a command', () => {
  const a = createApprovals()
  void a.request('n', bash(`echo hi${' '.repeat(500)}\n\t\x1b[2K; rm -rf x`))
  expect(onlyPending(a).summary).toBe('echo hi [2K; rm -rf x')
  a.clearNode('n')
})

test('the per-node PermissionRequest hook timeout is longer than the hold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay settings '))
  try {
    const node: ClaudeNode = {
      id: 'n',
      kind: 'claude',
      title: '',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      parentId: null,
      cwd: dir,
      sessionId: null,
      transcriptPath: null,
      after: []
    }
    const { args } = buildClaudeLaunch(node, {
      sessionDir: dir,
      hookScript: 'C:/hook.cjs',
      pluginDir: 'C:/skill',
      cliDir: 'C:/cli',
      endpointFile: 'C:/e.json',
      token: 't',
      claude: { file: 'claude.exe', prefixArgs: [] }
    })
    const { hooks } = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'))
    const timeout = hooks.PermissionRequest[0].hooks[0].timeout
    expect(timeout).toBe(600)
    expect(timeout * 1000).toBeGreaterThan(540000)
    expect(hooks.Stop[0].hooks[0].timeout).toBeLessThan(10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe_runner()

function describe_runner(): void {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patchbay approvals '))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function running() {
    const node: ClaudeNode = {
      id: 'c',
      kind: 'claude',
      title: '',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      parentId: null,
      cwd: dir,
      sessionId: null,
      transcriptPath: null,
      after: []
    }
    let doc: CanvasDoc = { version: 3, projects: [], activeProjectId: '', nodes: [node], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
    const store: CanvasStore = {
      get: () => doc,
      dispatch(op) {
        doc = reduce(doc, op)
      },
      subscribe: () => () => {}
    }
    const host = createEchoSessionHost()
    const tracker = createStatusTracker({ notify: () => {} })
    const approvals = createApprovals()
    const runner = createNodeRunner({
      host,
      tracker,
      store,
      approvals,
      ctx: {
        sessionDir: dir,
        hookScript: 'C:/hook.cjs',
        pluginDir: 'C:/skill',
        cliDir: 'C:/cli',
        endpointFile: 'C:/e.json',
        secret: 's',
        claude: { file: 'claude.exe', prefixArgs: [] }
      }
    })
    await runner.startNode('c')
    const ask = () => runner.handleHook('c', { hook_event_name: 'PermissionRequest', ...bash() })
    return { host, tracker, approvals, runner, ask }
  }

  test('a PermissionRequest reads needs-you and replies with the decision; the button means working', async () => {
    const { tracker, approvals, ask } = await running()
    const reply = ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1))
    expect(tracker.get('c')).toBe('needs-you')
    approvals.answer(approvals.pending()[0].requestId, 'allow')
    await expect(reply).resolves.toEqual({ decision: 'allow' })
    expect(tracker.get('c')).toBe('working')
  })

  test('any later hook from that node clears its pending request', async () => {
    const { approvals, runner, ask, tracker } = await running()
    const reply = ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1))
    await runner.handleHook('c', { hook_event_name: 'PostToolUse' })
    expect(approvals.pending()).toEqual([])
    await expect(reply).resolves.toEqual({ decision: null })
    expect(tracker.get('c')).toBe('working')
  })

  test('the late permission notification does not clear the buttons it is announcing', async () => {
    const { approvals, runner, ask } = await running()
    void ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1))
    await runner.handleHook('c', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    expect(approvals.pending()).toHaveLength(1)
    approvals.clearNode('c')
  })

  test('a second request while one is pending leaves both answerable', async () => {
    const { approvals, ask } = await running()
    const first = ask()
    const second = ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(2))
    const [a, b] = approvals.pending()
    approvals.answer(a.requestId, 'allow')
    approvals.answer(b.requestId, 'deny')
    await expect(first).resolves.toEqual({ decision: 'allow' })
    await expect(second).resolves.toEqual({ decision: 'deny' })
  })

  test('the status stays needs-you while another request from that node is waiting', async () => {
    const { approvals, ask, tracker } = await running()
    const first = ask()
    void ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(2))
    approvals.answer(approvals.pending()[0].requestId, 'allow')
    await first
    expect(tracker.get('c')).toBe('needs-you')
    approvals.clearNode('c')
  })

  test('an interrupt key clears the request, since Esc at a prompt fires no hook', async () => {
    const { approvals, runner, ask, tracker } = await running()
    const reply = ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1))
    runner.noteInput('c', '\x1b')
    await expect(reply).resolves.toEqual({ decision: null })
    expect(tracker.get('c')).toBe('unknown')
  })

  test('the process exiting clears the request', async () => {
    const { host, approvals, ask } = await running()
    const reply = ask()
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1))
    await host.kill('c')
    await expect(reply).resolves.toEqual({ decision: null })
  })

  test('the held connection closing clears the request', async () => {
    const { approvals, runner } = await running()
    const controller = new AbortController()
    const reply = runner.handleHook('c', { hook_event_name: 'PermissionRequest', ...bash() }, controller.signal)
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1))
    controller.abort()
    await expect(reply).resolves.toEqual({ decision: null })
    expect(approvals.pending()).toEqual([])
  })

  test('a question still reads needs-you with no buttons', async () => {
    const { approvals, runner, tracker } = await running()
    const reply = await runner.handleHook('c', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    })
    expect(reply).toEqual({ decision: null })
    expect(approvals.pending()).toEqual([])
    expect(tracker.get('c')).toBe('needs-you')
  })
}
