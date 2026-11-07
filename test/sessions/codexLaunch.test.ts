import { expect, test } from 'vitest'
import { buildCodexLaunch, CODEX_HOOK_EVENTS, codexHookArgs, type CodexLaunchContext } from '../../src/main/sessions/codexLaunch'
import type { ClaudeNode } from '../../src/shared/model'

const node = (over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id: 'n1',
  kind: 'claude',
  agent: 'codex',
  title: 'Codex',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  parentId: null,
  cwd: 'C:\\work',
  sessionId: null,
  transcriptPath: null,
  after: [],
  ...over
})

const ctx = (over: Partial<CodexLaunchContext> = {}): CodexLaunchContext => ({
  hookScript: 'C:\\Program Files\\Patchbay\\resources\\hook.cjs',
  cliDir: 'C:\\Program Files\\Patchbay\\resources\\cli',
  endpointFile: 'C:\\Users\\me\\AppData\\Roaming\\Patchbay\\control.json',
  token: 'tok',
  codex: { file: 'C:\\bin\\codex.exe', prefixArgs: [] },
  baseEnv: { Path: 'C:\\Windows', CLAUDECODE: '1' },
  ...over
})

test('every hook is a -c override whose command never changes between nodes, so Codex asks to trust it only once', () => {
  const args = codexHookArgs('C:\\Program Files\\Patchbay\\resources\\hook.cjs')
  expect(args).toHaveLength(CODEX_HOOK_EVENTS.length * 2)
  expect(args[1]).toBe('hooks.SessionStart=[{hooks=[{type="command",command="node \\"C:/Program Files/Patchbay/resources/hook.cjs\\" SessionStart"}]}]')
  const a = buildCodexLaunch(node({ id: 'a' }), ctx()).args.filter((x) => x.startsWith('hooks.'))
  const b = buildCodexLaunch(node({ id: 'b' }), ctx()).args.filter((x) => x.startsWith('hooks.'))
  expect(a).toEqual(b)
})

test('a new node passes its prompt after --, and the node travels in the environment', () => {
  const launch = buildCodexLaunch(node({ prompt: '-v is not a flag here' }), ctx())
  expect(launch.file).toBe('C:\\bin\\codex.exe')
  expect(launch.args.slice(-2)).toEqual(['--', '-v is not a flag here'])
  expect(launch.args.some((a) => a.startsWith('developer_instructions=') && a.includes('guide'))).toBe(true)
  expect(launch.env.PATCHBAY_NODE_ID).toBe('n1')
  expect(launch.env.CLAUDECODE).toBeUndefined()
  expect(launch.resumed).toBe(false)
  // Codex chooses its own id, which comes back with SessionStart.
  expect(launch.sessionId).toBe('')
})

test('a node with a session resumes it', () => {
  const launch = buildCodexLaunch(node({ sessionId: '01a1b417-7804-7de2-9708-a1a98b5cc824', prompt: 'ignored' }), ctx())
  expect(launch.args[0]).toBe('resume')
  expect(launch.args.at(-1)).toBe('01a1b417-7804-7de2-9708-a1a98b5cc824')
  expect(launch.args).not.toContain('ignored')
  expect(launch.resumed).toBe(true)
})

test('a batch-file codex runs through cmd.exe with every argument quoted', () => {
  const launch = buildCodexLaunch(node({ prompt: 'a & b' }), ctx({ codex: { file: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', 'C:\\npm\\codex.cmd'] } }))
  expect(launch.file).toBe('cmd.exe')
  expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
  expect(launch.args[3]).toMatch(/^"C:\\npm\\codex\.cmd /)
  expect(launch.args[3]).toContain('^^^&')
})
