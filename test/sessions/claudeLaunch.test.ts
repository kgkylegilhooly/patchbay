import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  buildClaudeLaunch,
  claudeAt,
  patchbayPermissions,
  rulePath,
  resolveClaude,
  type ClaudeLaunchContext
} from '../../src/main/sessions/claudeLaunch'
import { createSessionHost } from '../../src/main/sessions/host'
import type { ClaudeNode } from '../../src/shared/model'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay launch '))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

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
  pluginDir: 'C:\\Program Files\\Patchbay\\resources\\skill',
  cliDir: 'C:\\Program Files\\Patchbay\\resources\\cli',
  endpointFile: 'C:\\Users\\me\\AppData\\Roaming\\Patchbay\\control.json',
  token: 'tok',
  claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
  baseEnv: { Path: 'C:\\Windows', CLAUDECODE: '1', CLAUDE_CODE_X: '1' },
  ...over
})

const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]

test('new node gets --session-id with a uuid; the node keeps that uuid as sessionId', () => {
  const launch = buildClaudeLaunch(node(), ctx())
  expect(launch.args).toContain('--session-id')
  expect(after(launch.args, '--session-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(launch.sessionId).toBe(after(launch.args, '--session-id'))
  expect(launch.resumed).toBe(false)
  expect(launch.args).not.toContain('--resume')
})

test('a new node passes its prompt as one positional arg after --', () => {
  const launch = buildClaudeLaunch(node({ prompt: '-looks like a flag' }), ctx())
  expect(launch.args.slice(-2)).toEqual(['--', '-looks like a flag'])
})

test('a new node with no prompt, or a blank one, passes no positional arg', () => {
  expect(buildClaudeLaunch(node(), ctx()).args).not.toContain('--')
  expect(buildClaudeLaunch(node({ prompt: '  ' }), ctx()).args).not.toContain('--')
})

test('node with a sessionId launches with --resume <id> and without its prompt', () => {
  const launch = buildClaudeLaunch(node({ sessionId: 'abc', prompt: 'do not replay me' }), ctx())
  expect(after(launch.args, '--resume')).toBe('abc')
  expect(launch.sessionId).toBe('abc')
  expect(launch.resumed).toBe(true)
  expect(launch.args).not.toContain('--session-id')
  expect(launch.args).not.toContain('do not replay me')
  expect(launch.args).not.toContain('--')
})

test('permission mode is passed through when set', () => {
  expect(after(buildClaudeLaunch(node(), ctx({ permissionMode: 'default' })).args, '--permission-mode')).toBe('default')
  expect(buildClaudeLaunch(node(), ctx()).args).not.toContain('--permission-mode')
})

test('settings file path with spaces is one arg', () => {
  const launch = buildClaudeLaunch(node(), ctx())
  const settings = after(launch.args, '--settings')
  expect(settings).toContain(' ')
  expect(JSON.parse(readFileSync(settings, 'utf8')).hooks).toBeDefined()
  expect(after(launch.args, '--plugin-dir')).toBe('C:\\Program Files\\Patchbay\\resources\\skill')
})

test('an agent may read Patchbay\'s skill and exports, and run the verbs that only look, without asking', () => {
  const launch = buildClaudeLaunch(node(), ctx())
  const { permissions } = JSON.parse(readFileSync(after(launch.args, '--settings'), 'utf8'))
  expect(permissions.allow).toContain('Read(//c/Program Files/Patchbay/resources/skill/**)')
  expect(permissions.allow.some((r: string) => /^Read\(.*\/whiteboards\/\*\*\)$/.test(r))).toBe(true)
  expect(permissions.allow).toContain('Bash(patchbay whoami)')
  expect(permissions.allow).toContain('Bash(patchbay whiteboard *)')
  // Anything that changes the canvas, sends, or runs something still asks.
  for (const verb of ['send', 'open-agent', 'open-terminal', 'spawn-team', 'draw', 'note', 'close', 'link', 'sticky', 'browser']) {
    expect(permissions.allow.some((r: string) => r.startsWith(`Bash(patchbay ${verb}`))).toBe(false)
  }
  expect(permissions.deny).toBeUndefined()
})

test('paths are written the way Claude Code matches them on Windows', () => {
  expect(rulePath('C:\\Users\\me\\AppData\\Roaming\\Patchbay\\whiteboards')).toBe('//c/Users/me/AppData/Roaming/Patchbay/whiteboards')
  expect(rulePath('D:/data/')).toBe('//d/data')
  expect(rulePath('/home/me/patchbay')).toBe('//home/me/patchbay')
  expect(patchbayPermissions([])).toEqual(expect.arrayContaining(['Bash(patchbay list)', 'Bash(patchbay list *)']))
})

test('the settings file names every hook, with the script quoted and in forward slashes', () => {
  const launch = buildClaudeLaunch(node(), ctx())
  const { hooks } = JSON.parse(readFileSync(after(launch.args, '--settings'), 'utf8'))
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
    'StopFailure',
    'PermissionRequest',
    'Notification',
    'SessionEnd'
  ]) {
    expect(hooks[event][0].hooks[0]).toMatchObject({
      type: 'command',
      command: `node "C:/Program Files/Patchbay/resources/hook.cjs" ${event}`
    })
  }
})

test('a node id with path characters stays inside the session folder', () => {
  const launch = buildClaudeLaunch(node({ id: '..\\..\\evil/x' }), ctx())
  expect(resolve(after(launch.args, '--settings')).startsWith(resolve(join(dir, 'sessions')))).toBe(true)
})

test('env holds PATCHBAY_* and PATH begins with the cli folder', () => {
  const { env, cwd, nodeId } = buildClaudeLaunch(node(), ctx())
  expect(env.PATCHBAY_NODE_ID).toBe('n1')
  expect(env.PATCHBAY_TOKEN).toBe('tok')
  expect(env.PATCHBAY_ENDPOINT_FILE).toBe('C:\\Users\\me\\AppData\\Roaming\\Patchbay\\control.json')
  expect(env.PATH).toBe(`C:\\Program Files\\Patchbay\\resources\\cli${delimiter}C:\\Windows`)
  expect(env.Path).toBeUndefined()
  expect(env.CLAUDECODE).toBeUndefined()
  expect(env.CLAUDE_CODE_X).toBeUndefined()
  expect(cwd).toBe(dir)
  expect(nodeId).toBe('n1')
})

test('resolveClaude finds the real executable as a full path, not a bare name', () => {
  const { file, prefixArgs } = resolveClaude()
  expect(file).toMatch(/^[a-z]:\\/i)
  expect(prefixArgs).toEqual([])
})

test('claudeAt runs an .exe directly and a .cmd through cmd.exe', () => {
  expect(claudeAt('C:\\x\\claude.exe')).toEqual({ file: 'C:\\x\\claude.exe', prefixArgs: [] })
  const shim = claudeAt('C:\\x y\\claude.cmd')
  expect(shim.file).toMatch(/cmd(\.exe)?$/i)
  expect(shim.prefixArgs.slice(0, 3)).toEqual(['/d', '/s', '/c'])
})

const NASTY = [
  'say "hi there" to it',
  'a & b | c > d < e ^ f',
  '%PATH% !x! $HOME `tick` (paren)',
  'back\\slash\\ and trailing\\',
  "it's, ok; yes = no * ?",
  'ends with quote"',
  'trailing backslash then quote\\"',
  '-flaglike'
]

function dumpScript(out: string): string {
  const script = join(dir, 'dump argv.cjs')
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`)
  return script
}

async function runReal(file: string, args: string[], out: string): Promise<string[]> {
  const host = createSessionHost()
  const exited = new Promise<number>((done) => host.onExit((_id, code) => done(code)))
  host.start({ nodeId: 'x', file, args, cwd: dir, env: process.env as Record<string, string> })
  await exited
  return JSON.parse(readFileSync(out, 'utf8'))
}

test.each(NASTY)('a prompt with quotes and a path with spaces arrive as single args: %s', async (prompt) => {
  const out = join(dir, 'argv.json')
  const launch = buildClaudeLaunch(
    node({ prompt }),
    ctx({ claude: { file: process.execPath, prefixArgs: [dumpScript(out)] } })
  )
  const argv = await runReal(launch.file, launch.args, out)
  expect(argv.slice(-2)).toEqual(['--', prompt])
  expect(argv).toContain(after(launch.args, '--settings'))
}, 30000)

test.each(NASTY)('the .cmd case runs through cmd.exe with correct quoting: %s', async (prompt) => {
  const out = join(dir, 'argv.json')
  const script = dumpScript(out)
  const shim = join(dir, 'my claude (x86) & co.cmd')
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  const launch = buildClaudeLaunch(node({ prompt }), ctx({ claude: claudeAt(shim) }))
  expect(launch.file).toMatch(/cmd(\.exe)?$/i)
  const argv = await runReal(launch.file, launch.args, out)
  expect(argv.slice(-2)).toEqual(['--', prompt])
  expect(argv[0]).toBe('--settings')
  expect(argv[1]).toBe(join(dir, 'sessions', 'n1.settings.json'))
}, 30000)

test('a .cmd launch flattens newlines in a prompt, since cmd.exe would cut the line there', async () => {
  const out = join(dir, 'argv.json')
  const script = dumpScript(out)
  const shim = join(dir, 'claude.cmd')
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  const launch = buildClaudeLaunch(node({ prompt: 'line one\r\nline two\nend' }), ctx({ claude: claudeAt(shim) }))
  const argv = await runReal(launch.file, launch.args, out)
  expect(argv.slice(-2)).toEqual(['--', 'line one line two end'])
}, 30000)

test('a direct launch keeps newlines in a prompt', () => {
  const launch = buildClaudeLaunch(node({ prompt: 'line one\nline two' }), ctx())
  expect(launch.args.slice(-1)).toEqual(['line one\nline two'])
})
