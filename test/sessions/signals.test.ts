import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { bashWord, buildClaudeLaunch, hookCommand, statusLineCommand, type ClaudeLaunchContext } from '../../src/main/sessions/claudeLaunch'
import { claudeRunsBash } from '../../src/main/sessions/shell'
import { parseSignalName, signalFile, statusFile, watchSignals, type SignalWatcher } from '../../src/main/sessions/signals'
import type { ClaudeNode } from '../../src/shared/model'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const hasBash = existsSync(GIT_BASH)

let dir: string
let watcher: SignalWatcher | null = null

beforeEach(() => {
  // An apostrophe and spaces, as a Windows user name can have, so the quoting is tested where it matters.
  dir = mkdtempSync(join(tmpdir(), "patchbay o'brien signals "))
})

afterEach(() => {
  watcher?.close()
  watcher = null
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

const node = (id = 'n1'): ClaudeNode => ({ id, kind: 'claude', title: 'Claude', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: dir, sessionId: null, transcriptPath: null, after: [] })

const ctx = (over: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext => ({
  sessionDir: join(dir, 'sessions'),
  hookScript: 'C:\\Program Files\\Patchbay\\resources\\hook.cjs',
  statusLineScript: 'C:\\Program Files\\Patchbay\\resources\\statusline.cjs',
  signalDir: join(dir, 'signals'),
  pluginDir: 'C:\\p\\skill',
  cliDir: 'C:\\p\\cli',
  endpointFile: 'C:\\p\\control.json',
  token: 'tok',
  claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
  baseEnv: { Path: 'C:\\Windows' },
  home: dir,
  ...over
})

/** Runs a command the way Claude Code does on Windows. */
const asClaude = (command: string, input: string, env: NodeJS.ProcessEnv = {}): { stdout: string; status: number | null } => {
  const r = spawnSync(GIT_BASH, ['-c', command], { input, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true })
  return { stdout: r.stdout, status: r.status }
}

test('a node id can be told back from its file name, whatever it holds', () => {
  for (const id of ['n1', 'a.b.c', '..\\..\\evil/x', 'spaced id', "o'brien"]) {
    const name = signalFile(dir, id, 'PostToolUse').slice(dir.length + 1)
    expect(name).not.toMatch(/[\\/]/)
    expect(parseSignalName(name)).toEqual({ nodeId: id, kind: 'PostToolUse' })
  }
  expect(parseSignalName('n1.settings')).toBeNull()
  expect(parseSignalName('PostToolUse')).toBeNull()
})

test('bashWord keeps a path one word, apostrophes and all', () => {
  expect(bashWord("C:\\Users\\o'brien\\x y")).toBe(`'C:/Users/o'\\''brien/x y'`)
})

test('without a folder to signal through, every hook and the status line run Node as before', () => {
  const c = ctx({ signalDir: undefined })
  expect(hookCommand('PostToolUse', 'n1', c)).toBe('node "C:/Program Files/Patchbay/resources/hook.cjs" PostToolUse')
  expect(statusLineCommand('n1', c, null)).toBe('node "C:/Program Files/Patchbay/resources/statusline.cjs"')
})

test('with one, only the tool hooks and the status line change, and the rest still run hook.cjs', () => {
  const launch = buildClaudeLaunch(node(), ctx())
  const settings = JSON.parse(readFileSync(launch.args[launch.args.indexOf('--settings') + 1], 'utf8'))
  expect(settings.hooks.PostToolUse[0].hooks[0].command).toMatch(/^: > '.*n1\.PostToolUse'$/)
  expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toMatch(/^: > '.*n1\.PostToolUseFailure'$/)
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification']) {
    expect(settings.hooks[event][0].hooks[0].command).toBe(`node "C:/Program Files/Patchbay/resources/hook.cjs" ${event}`)
  }
  expect(settings.statusLine.command).not.toMatch(/node/)
})

test('Claude runs bash for its commands where its own setting or the usual install says', () => {
  expect(claudeRunsBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe' }, (p) => p.startsWith('D:'))).toBe(true)
  expect(claudeRunsBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone.exe' }, () => false)).toBe(false)
  expect(claudeRunsBash({}, (p) => p === GIT_BASH)).toBe(true)
  expect(claudeRunsBash({}, () => false)).toBe(false)
})

test.runIf(hasBash)('in real Git Bash, a tool hook touches its file, and nothing else starts', () => {
  mkdirSync(join(dir, 'signals', 'status'), { recursive: true })
  const r = asClaude(hookCommand('PostToolUse', 'n1', ctx()), JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(200_000) }))
  expect(r.status).toBe(0)
  expect(existsSync(signalFile(join(dir, 'signals'), 'n1', 'PostToolUse'))).toBe(true)
})

test.runIf(hasBash)('in real Git Bash, the status line saves its input whole and prints nothing of its own', () => {
  mkdirSync(join(dir, 'signals', 'status'), { recursive: true })
  const input = JSON.stringify({ session_id: 's', cost: { total_cost_usd: 1.5 }, text: 'quotes " \' and $dollars `ticks` \\ and ünïcode' })
  const r = asClaude(statusLineCommand('n1', ctx(), null) ?? '', input)
  expect(r.status).toBe(0)
  expect(r.stdout).toBe('')
  expect(readFileSync(statusFile(join(dir, 'signals'), 'n1'), 'utf8')).toBe(input)
})

test.runIf(hasBash)("in real Git Bash, the owner's own status line gets the same input and is what's shown", () => {
  mkdirSync(join(dir, 'signals', 'status'), { recursive: true })
  const script = join(dir, 'own line.cjs')
  writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('OWN '+JSON.parse(s).session_id))")
  const own = `node "${script.replace(/\\/g, '/')}"`
  const input = JSON.stringify({ session_id: 'abc' })
  const r = asClaude(statusLineCommand('n1', ctx(), { command: own }) ?? '', input, { PATCHBAY_STATUSLINE_FORWARD: own })
  expect(r.stdout).toBe('OWN abc')
  expect(readFileSync(statusFile(join(dir, 'signals'), 'n1'), 'utf8')).toBe(input)
})

test('a touched file is handed on as that hook, once', async () => {
  const hooks: string[] = []
  watcher = watchSignals({ dir, onHook: (id, name) => hooks.push(`${id} ${name}`), onStatus: () => {}, pollMs: 100 })
  writeFileSync(signalFile(dir, 'n1', 'PostToolUse'), '')
  await until(() => hooks.length > 0)
  await sleep(300)
  expect(hooks).toEqual(['n1 PostToolUse'])
  writeFileSync(signalFile(dir, 'n1', 'PostToolUse'), '')
  const later = Date.now() / 1000 + 1
  utimesSync(signalFile(dir, 'n1', 'PostToolUse'), later, later)
  await until(() => hooks.length > 1)
  expect(hooks).toEqual(['n1 PostToolUse', 'n1 PostToolUse'])
})

test('a signal from before a hook that came the usual way is old news, so a late one cannot undo a Stop', async () => {
  const hooks: string[] = []
  writeFileSync(join(dir, 'unrelated.txt'), '')
  watcher = watchSignals({ dir, onHook: (id, name) => hooks.push(`${id} ${name}`), onStatus: () => {}, pollMs: 100 })
  const file = signalFile(dir, 'n1', 'PostToolUse')
  writeFileSync(file, '')
  const touched = Date.now() / 1000 - 5
  utimesSync(file, touched, touched)
  watcher.heardHook('n1', Date.now())
  await sleep(400)
  expect(hooks).toEqual([])
  expect(watcher.latestHook('n1')).toBeCloseTo(touched * 1000, -2)
})

test('what was already there at launch is noted but not acted on', async () => {
  const file = signalFile(dir, 'n1', 'PostToolUse')
  writeFileSync(file, '')
  const hooks: string[] = []
  watcher = watchSignals({ dir, onHook: (id, name) => hooks.push(`${id} ${name}`), onStatus: () => {}, pollMs: 100 })
  await sleep(400)
  expect(hooks).toEqual([])
  expect(watcher.latestHook('n1')).toBeGreaterThan(0)
})

test('a status line is read once its write is whole, and a half-written one is read again', async () => {
  const seen: string[] = []
  watcher = watchSignals({ dir, onHook: () => {}, onStatus: (id, text) => seen.push(`${id} ${text}`), pollMs: 100, statusEveryMs: 100 })
  const file = statusFile(dir, 'n1')
  writeFileSync(file, '{"session_id":')
  await sleep(400)
  expect(seen).toEqual([])
  writeFileSync(file, '{"session_id":"s1"}')
  await until(() => seen.length > 0)
  expect(seen).toEqual(['n1 {"session_id":"s1"}'])
})

test('forget removes a closed node\'s files', async () => {
  watcher = watchSignals({ dir, onHook: () => {}, onStatus: () => {}, pollMs: 100 })
  writeFileSync(signalFile(dir, 'gone', 'PostToolUse'), '')
  writeFileSync(statusFile(dir, 'gone'), '{}')
  watcher.forget('gone')
  expect(existsSync(signalFile(dir, 'gone', 'PostToolUse'))).toBe(false)
  expect(existsSync(statusFile(dir, 'gone'))).toBe(false)
})

test('a status line written many times a second is read at most once a second, and an unchanged one not at all', async () => {
  const seen: string[] = []
  watcher = watchSignals({ dir, onHook: () => {}, onStatus: (_id, text) => seen.push(text), pollMs: 60_000 })
  const file = statusFile(dir, 'n1')
  for (let i = 0; i < 12; i++) {
    writeFileSync(file, JSON.stringify({ n: i }))
    await sleep(100)
  }
  await sleep(1300)
  // Twelve writes over 1.2 s: one read for the first burst and one a second after, never twelve.
  expect(seen.length).toBeGreaterThanOrEqual(1)
  expect(seen.length).toBeLessThanOrEqual(3)
  expect(seen.at(-1)).toBe(JSON.stringify({ n: 11 }))
  const count = seen.length
  writeFileSync(file, JSON.stringify({ n: 11 }))
  await sleep(1300)
  expect(seen.length).toBe(count)
})
