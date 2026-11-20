import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bashWord, buildClaudeLaunch, hookCommand, statusLineCommand, type ClaudeLaunchContext } from '../../src/main/sessions/claudeLaunch'
import { claudeRunsBash } from '../../src/main/sessions/shell'
import { parseSignalName, signalFile, statusFile, watchSignals, type SignalWatcher } from '../../src/main/sessions/signals'
import type { ClaudeNode } from '../../src/shared/model'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const hasBash = existsSync(GIT_BASH)

let dir: string
let watcher: SignalWatcher | null = null

beforeEach(() => {
  // An apostrophe, spaces and letters beyond ASCII, as Windows user names can have, so the quoting is tested where it matters.
  dir = mkdtempSync(join(tmpdir(), "patchbay o'brien Jürgen 日本 signals "))
})

afterEach(async () => {
  watcher?.close()
  watcher = null
  await removeTemp(dir)
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 20_000): Promise<void> {
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
const asClaude = (command: string, input: string, env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } => {
  const r = spawnSync(GIT_BASH, ['-c', command], { input, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
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
  expect(r.stderr).toBe('')
  expect(readFileSync(statusFile(join(dir, 'signals'), 'n1'), 'utf8')).toBe(input)
})

test.runIf(hasBash)("an owner's status line run again within a second shows what it printed, without running again", async () => {
  mkdirSync(join(dir, 'signals', 'status'), { recursive: true })
  const script = join(dir, 'counting line.cjs')
  const runs = join(dir, 'runs.txt')
  // Prints which run it is, over two lines, so a status line of more than one line is shown whole.
  writeFileSync(script, `const fs=require('fs');const n=(fs.existsSync(${JSON.stringify(runs)})?fs.readFileSync(${JSON.stringify(runs)},'utf8').length:0)+1;fs.appendFileSync(${JSON.stringify(runs)},'x');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('run '+n+' for '+JSON.parse(s).session_id+'\\nsecond line'))`)
  const own = `node "${script.replace(/\\/g, '/')}"`
  const command = statusLineCommand('n1', ctx(), { command: own }) ?? ''
  // The cache's first line is when the owner's line last ran, in microseconds. The test sets it rather than racing the
  // clock: starting bash can take over a second on a busy machine.
  const cache = `${statusFile(join(dir, 'signals'), 'n1')}.line`
  const ranAt = (us: number): void => {
    const was = readFileSync(cache, 'utf8')
    writeFileSync(cache, `${us}${was.slice(was.indexOf('\n'))}`)
  }
  const first = asClaude(command, JSON.stringify({ session_id: 'a' }), { PATCHBAY_STATUSLINE_FORWARD: own })
  expect(first.stdout).toBe('run 1 for a\nsecond line')
  // Ran a moment ago, however long the next bash takes to start.
  ranAt(Date.now() * 1000 + 60_000_000)
  const again = asClaude(command, JSON.stringify({ session_id: 'b' }), { PATCHBAY_STATUSLINE_FORWARD: own })
  expect(again.stdout).toBe('run 1 for a\nsecond line')
  // Patchbay still gets the newest input every time.
  expect(readFileSync(statusFile(join(dir, 'signals'), 'n1'), 'utf8')).toBe(JSON.stringify({ session_id: 'b' }))
  // Ran over a second ago: it runs again.
  ranAt(Date.now() * 1000 - 1_500_000)
  const later = asClaude(command, JSON.stringify({ session_id: 'c' }), { PATCHBAY_STATUSLINE_FORWARD: own })
  expect(later.stdout).toBe('run 2 for c\nsecond line')
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
  // The once-a-second look is stepped by hand, so the count doesn't depend on how busy the machine is.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const seen: string[] = []
    watcher = watchSignals({ dir, onHook: () => {}, onStatus: (id, text) => seen.push(`${id} ${text}`), pollMs: 60_000 })
    /** Seconds pass, one at a time, until what they read has come in. A second with nothing new reads nothing. */
    const secondsUntil = async (fn: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !fn(); i++) {
        await vi.advanceTimersByTimeAsync(1000)
        await sleep(25)
      }
      expect(fn()).toBe(true)
    }
    const file = statusFile(dir, 'n1')
    // Six writes within one second, then six in the next: one read a second, of the newest, never twelve.
    for (let i = 0; i < 6; i++) writeFileSync(file, JSON.stringify({ n: i }))
    await secondsUntil(() => seen.length === 1)
    for (let i = 6; i < 12; i++) writeFileSync(file, JSON.stringify({ n: i }))
    await secondsUntil(() => seen.length === 2)
    expect(seen).toEqual([`n1 ${JSON.stringify({ n: 5 })}`, `n1 ${JSON.stringify({ n: 11 })}`])
    // Written again unchanged, with a newer time: read, and not passed on. Another node's line shows the read happened.
    writeFileSync(file, JSON.stringify({ n: 11 }))
    const later = Date.now() / 1000 + 5
    utimesSync(file, later, later)
    writeFileSync(statusFile(dir, 'n2'), '{}')
    await secondsUntil(() => seen.includes('n2 {}'))
    // A look starts only once the one before has finished, so by this one the n1 read is done.
    writeFileSync(statusFile(dir, 'n3'), '{}')
    await secondsUntil(() => seen.includes('n3 {}'))
    expect(seen.filter((x) => x.startsWith('n1 '))).toHaveLength(2)
  } finally {
    vi.useRealTimers()
  }
})

test('a session from the build before, writing its status line beside the tool signals, is still read', async () => {
  const seen: string[] = []
  watcher = watchSignals({ dir, onHook: () => {}, onStatus: (id, text) => seen.push(`${id} ${text}`), pollMs: 60_000, statusEveryMs: 100 })
  writeFileSync(signalFile(dir, 'old', 'status'), '{"session_id":"legacy"}')
  await until(() => seen.length > 0)
  expect(seen).toEqual(['old {"session_id":"legacy"}'])
})
