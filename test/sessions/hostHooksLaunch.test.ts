import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { buildClaudeLaunch, HELD_HOOK_TIMEOUT_S, HOOK_EVENTS, HOOK_TIMEOUT_S, SESSION_END_TIMEOUT_S, type ClaudeLaunchContext } from '../../src/main/sessions/claudeLaunch'
import { claudeRunsExecHooks, claudeRunsHttpHooks, forgetHookRunners, HTTP_HOOKS_SINCE, runsHttpHooks } from '../../src/main/sessions/hookRunner'
import { createNodeRunner, type NodeRunnerContext } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasStore, SessionHost, SessionSpec } from '../../src/shared/contract'
import type { CanvasDoc, ClaudeNode } from '../../src/shared/model'

let dir: string
beforeEach(() => {
  forgetHookRunners()
  dir = mkdtempSync(join(tmpdir(), 'patchbay host hooks launch '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

const node = (over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id: 'n1',
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

const ctx = (over: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext => ({
  sessionDir: join(dir, 'sessions'),
  hookScript: 'C:\\Program Files\\Patchbay\\resources\\hook.cjs',
  pluginDir: 'C:\\skill',
  cliDir: 'C:\\cli',
  endpointFile: 'C:\\control\\endpoint.json',
  token: 'secret-token',
  claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
  baseEnv: { Path: 'C:\\Windows' },
  ...over
})

const settingsOf = (args: string[]): { text: string; hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> } => {
  const text = readFileSync(args[args.indexOf('--settings') + 1], 'utf8')
  return { text, hooks: JSON.parse(text).hooks }
}
const entry = (hooks: ReturnType<typeof settingsOf>['hooks'], event: string) => hooks[event][0].hooks[0]

test('with the host serving hooks, every event but SessionStart posts to it, with the token taken from the environment', () => {
  const launch = buildClaudeLaunch(node(), ctx({ hookPort: 51234, hookNode: 'C:\\Program Files\\nodejs\\node.exe' }))
  const { text, hooks } = settingsOf(launch.args)
  for (const event of HOOK_EVENTS.filter((e) => e !== 'SessionStart')) {
    expect(entry(hooks, event)).toEqual({
      type: 'http',
      url: `http://127.0.0.1:51234/hook/${event}`,
      headers: { authorization: 'Bearer $PATCHBAY_TOKEN', 'x-patchbay-node': '$PATCHBAY_NODE_ID' },
      allowedEnvVars: ['PATCHBAY_TOKEN', 'PATCHBAY_NODE_ID'],
      timeout: event === 'PermissionRequest' ? HELD_HOOK_TIMEOUT_S : event === 'SessionEnd' ? SESSION_END_TIMEOUT_S : HOOK_TIMEOUT_S
    })
  }
  // Claude Code runs only command hooks on SessionStart. It still starts Node directly, and returns the context.
  expect(entry(hooks, 'SessionStart')).toEqual({ type: 'command', command: 'C:\\Program Files\\nodejs\\node.exe', args: [ctx().hookScript, 'SessionStart'], timeout: HOOK_TIMEOUT_S })
  // The token stays in the session's environment, never in a file.
  expect(text).not.toContain('secret-token')
  expect(launch.env.PATCHBAY_TOKEN).toBe('secret-token')
  expect(launch.env.PATCHBAY_NODE_ID).toBe('n1')
  // So the host it's started in can be checked to be the one these hooks post to.
  expect(launch.hookPort).toBe(51234)
})

test("the tool events go over http too, rather than through bash's signal files", () => {
  const { hooks } = settingsOf(buildClaudeLaunch(node(), ctx({ hookPort: 51234, signalDir: join(dir, 'signals') })).args)
  expect(entry(hooks, 'PostToolUse').type).toBe('http')
  expect(entry(hooks, 'PostToolUseFailure').type).toBe('http')
})

test('without a host port, the settings are exactly the command hooks sessions have always had', () => {
  const launch = buildClaudeLaunch(node(), ctx({ hookNode: 'C:\\node.exe', signalDir: join(dir, 'signals') }))
  const { hooks } = settingsOf(launch.args)
  expect(Object.values(hooks).every((h) => h[0].hooks[0].type === 'command')).toBe(true)
  expect(entry(hooks, 'Stop')).toEqual({ type: 'command', command: 'C:\\node.exe', args: [ctx().hookScript, 'Stop'], timeout: HOOK_TIMEOUT_S })
  expect(String(entry(hooks, 'PostToolUse').command)).toMatch(/^: > /)
  expect(launch).not.toHaveProperty('hookPort')
  const old = settingsOf(buildClaudeLaunch(node({ id: 'n2' }), ctx()).args).hooks
  expect(entry(old, 'Stop')).toEqual({ type: 'command', command: 'node "C:/Program Files/Patchbay/resources/hook.cjs" Stop', timeout: HOOK_TIMEOUT_S })
})

test('http hooks need Claude Code 2.1.63, asked once along with exec form, and never of a custom command', async () => {
  expect(HTTP_HOOKS_SINCE).toEqual([2, 1, 63])
  expect(runsHttpHooks([2, 1, 62])).toBe(false)
  expect(runsHttpHooks([2, 1, 63])).toBe(true)
  expect(runsHttpHooks([2, 2, 0])).toBe(true)
  expect(runsHttpHooks(null)).toBe(false)
  const claude = { file: 'C:\\bin\\claude.exe', prefixArgs: [] }
  const ask = vi.fn(async () => '2.1.100 (Claude Code)\n')
  expect(await claudeRunsHttpHooks({ claude }, ask)).toBe(true)
  // 2.1.100 has http hooks but not exec form.
  expect(await claudeRunsExecHooks({ claude }, ask)).toBe(false)
  expect(ask).toHaveBeenCalledTimes(1)
  const never = vi.fn(async () => '2.1.330')
  expect(await claudeRunsHttpHooks({ claude, claudeCommand: 'wsl claude' }, never)).toBe(false)
  expect(await claudeRunsHttpHooks({ claude, claudeTerminal: 'pwsh.exe' }, never)).toBe(false)
  expect(await claudeRunsHttpHooks({}, never)).toBe(false)
  expect(never).not.toHaveBeenCalled()
  const failing = vi.fn(async () => {
    throw new Error('gone')
  })
  expect(await claudeRunsHttpHooks({ claude: { file: 'C:\\other\\claude.exe', prefixArgs: [] } }, failing)).toBe(false)
})

function runnerWith(over: Partial<NodeRunnerContext>) {
  let doc: CanvasDoc = { version: 3, nodes: [node()], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } as unknown as CanvasDoc
  const store = { get: () => doc, dispatch: (a: never) => void (doc = reduce(doc, a)), onChange: () => () => {} } as unknown as CanvasStore
  const specs: SessionSpec[] = []
  const host = {
    start: (s: SessionSpec) => void specs.push(s),
    write() {},
    resize() {},
    kill: async () => {},
    pid: () => null,
    isRunning: (id: string) => specs.some((s) => s.nodeId === id),
    snapshot: () => ({ data: '', seq: 0 }),
    onOutput() {},
    onExit() {}
  } as SessionHost
  const runner = createNodeRunner({
    host,
    tracker: createStatusTracker({ notify: () => {} }),
    store,
    ctx: { sessionDir: join(dir, 'sessions'), hookScript: 'C:/hook.cjs', pluginDir: 'C:/skill', cliDir: 'C:/cli', endpointFile: 'C:/e.json', secret: 's', claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] }, baseEnv: { PATH: 'C:\\Windows' }, hookNode: null, ...over }
  })
  return { runner, specs }
}

test('chosen per session at launch: http when the host serves hooks and Claude has them, else command hooks', async () => {
  const served = runnerWith({ hostHookPort: () => 40001, findHttpHooks: async () => true })
  await served.runner.startNode('n1')
  expect(served.specs[0].hookPort).toBe(40001)
  expect(entry(settingsOf(served.specs[0].args).hooks, 'Stop').url).toBe('http://127.0.0.1:40001/hook/Stop')

  const tooOld = runnerWith({ hostHookPort: () => 40001, findHttpHooks: async () => false })
  await tooOld.runner.startNode('n1')
  expect(tooOld.specs[0].hookPort).toBeUndefined()
  expect(entry(settingsOf(tooOld.specs[0].args).hooks, 'Stop').type).toBe('command')

  const noHost = vi.fn(async () => true)
  const inApp = runnerWith({ hostHookPort: () => null, findHttpHooks: noHost })
  await inApp.runner.startNode('n1')
  expect(entry(settingsOf(inApp.specs[0].args).hooks, 'Stop').type).toBe('command')
  expect(noHost).not.toHaveBeenCalled()
})
