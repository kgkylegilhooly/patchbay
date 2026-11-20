import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startControlServer, tokenFor } from '../../src/main/control/server'
import { buildClaudeLaunch, findUserStatusLine } from '../../src/main/sessions/claudeLaunch'
import { parseUsageReport } from '../../src/shared/usage'
import type { ClaudeNode } from '../../src/shared/model'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const SCRIPT = resolve(__dirname, '../../resources/statusline.cjs')
const INPUT = JSON.stringify({ session_id: 's1', huge: 'x'.repeat(100), context_window: { used_percentage: 34 } })

let dir: string
let servers: Server[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay statusline '))
  servers = []
})

afterEach(async () => {
  for (const s of servers) s.close()
  await removeTemp(dir)
})

test('parseUsageReport maps the real shape and drops malformed fields', () => {
  expect(
    parseUsageReport({
      session_id: 's',
      cost: { total_cost_usd: 0.5 },
      context_window: { used_percentage: 34, context_window_size: 200000, total_input_tokens: 10, total_output_tokens: 5 },
      rate_limits: { five_hour: { used_percentage: 48, resets_at: 9 }, seven_day: 'x' }
    })
  ).toEqual({ sessionId: 's', costUsd: 0.5, contextPercent: 34, contextSize: 200000, tokens: 15, fiveHour: { percent: 48, resetsAt: 9 } })
  expect(parseUsageReport({ context_window: { used_percentage: '34' }, rate_limits: { five_hour: { used_percentage: 1 } } })).toEqual({})
  expect(parseUsageReport('nope')).toEqual({})
  expect(parseUsageReport(null)).toEqual({})
})

function settingsAt(folder: string, name: string, text: string): void {
  mkdirSync(join(folder, '.claude'), { recursive: true })
  writeFileSync(join(folder, '.claude', name), text)
}

const line = (command: string): string => JSON.stringify({ statusLine: { type: 'command', command, padding: 2 } })

test('findUserStatusLine prefers project local, then project, then user', () => {
  const project = join(dir, 'project')
  const home = join(dir, 'home')
  settingsAt(home, 'settings.json', line('user'))
  expect(findUserStatusLine(project, home)).toEqual({ command: 'user', padding: 2 })
  settingsAt(project, 'settings.json', line('shared'))
  expect(findUserStatusLine(project, home)?.command).toBe('shared')
  settingsAt(project, 'settings.local.json', line('local'))
  expect(findUserStatusLine(project, home)?.command).toBe('local')
})

test('findUserStatusLine skips a corrupt file, and is null with none set', () => {
  const project = join(dir, 'project')
  const home = join(dir, 'home')
  expect(findUserStatusLine(project, home)).toBeNull()
  settingsAt(project, 'settings.json', '{ oops')
  settingsAt(home, 'settings.json', line('user'))
  expect(findUserStatusLine(project, home)?.command).toBe('user')
})

function launchFor(home: string) {
  const node: ClaudeNode = { id: 'n1', kind: 'claude', title: 'C', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: dir, sessionId: null, transcriptPath: null, after: [] }
  return buildClaudeLaunch(node, {
    sessionDir: join(dir, 'sessions'),
    hookScript: 'C:\\app\\hook.cjs',
    statusLineScript: 'C:\\app\\status line.cjs',
    pluginDir: 'p',
    cliDir: 'c',
    endpointFile: 'e',
    token: 't',
    claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
    baseEnv: { Path: 'C:\\Windows' },
    home
  })
}

test('the session settings file holds both hooks and the status line command', () => {
  const launch = launchFor(join(dir, 'home'))
  const file = launch.args[launch.args.indexOf('--settings') + 1]
  const settings = JSON.parse(readFileSync(file, 'utf8'))
  expect(settings.hooks.Stop).toBeTruthy()
  expect(settings.statusLine).toEqual({ type: 'command', command: 'node "C:/app/status line.cjs"' })
})

test('the status line keeps the padding the owner set', () => {
  const home = join(dir, 'home')
  settingsAt(home, 'settings.json', line('mine'))
  const launch = launchFor(home)
  const file = launch.args[launch.args.indexOf('--settings') + 1]
  expect(JSON.parse(readFileSync(file, 'utf8')).statusLine.padding).toBe(2)
})

test('the launch env carries the owner command, and omits it when there is none', () => {
  const home = join(dir, 'home')
  expect(launchFor(home).env.PATCHBAY_STATUSLINE_FORWARD).toBeUndefined()
  settingsAt(home, 'settings.json', line('mine --flag'))
  expect(launchFor(home).env.PATCHBAY_STATUSLINE_FORWARD).toBe('mine --flag')
})

/** A stand-in for the control server, recording what reaches it. */
async function fakeServer(): Promise<{ file: string; bodies: unknown[]; headers: Array<Record<string, unknown>> }> {
  const bodies: unknown[] = []
  const headers: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => {
      bodies.push(JSON.parse(text))
      headers.push({ url: req.url, ...req.headers })
      res.end('{}')
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const file = join(dir, 'endpoint.json')
  writeFileSync(file, JSON.stringify({ port: (server.address() as AddressInfo).port }))
  return { file, bodies, headers }
}

function run(env: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, PATCHBAY_NODE_ID: 'n1', PATCHBAY_TOKEN: 'tok', ...env }, stdio: 'pipe' })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', (code) => done({ code, out, ms: Date.now() - started }))
    child.stdin.end(INPUT)
  })
}

/** Prints what it read, so a test can tell the same input reached it. */
function echoCommand(): string {
  const file = join(dir, 'echo.cjs')
  writeFileSync(file, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log('OWNER:'+JSON.parse(s).session_id))`)
  return `node "${file.replace(/\\/g, '/')}"`
}

test('statusline.cjs prints the forwarded output, from the same stdin', async () => {
  const { file } = await fakeServer()
  const r = await run({ PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_STATUSLINE_FORWARD: echoCommand() })
  expect(r.code).toBe(0)
  expect(r.out.trim()).toBe('OWNER:s1')
})

test('statusline.cjs sends only the usage fields, to /usage with the token', async () => {
  const { file, bodies, headers } = await fakeServer()
  const r = await run({ PATCHBAY_ENDPOINT_FILE: file })
  expect(r.code).toBe(0)
  expect(bodies).toEqual([{ session_id: 's1', context_window: { used_percentage: 34 } }])
  expect(headers[0]).toMatchObject({ url: '/usage', authorization: 'Bearer tok', 'x-patchbay-node': 'n1' })
})

test('statusline.cjs still draws the owner line with the server down', async () => {
  const r = await run({ PATCHBAY_ENDPOINT_FILE: join(dir, 'missing.json'), PATCHBAY_STATUSLINE_FORWARD: echoCommand() })
  expect(r.code).toBe(0)
  // Printed at all shows it didn't wait for the server: the script ends itself, printing nothing, 5.5 s in.
  expect(r.out.trim()).toBe('OWNER:s1')
})

test('statusline.cjs prints nothing when the forwarded command fails', async () => {
  const { file, bodies } = await fakeServer()
  const r = await run({ PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_STATUSLINE_FORWARD: `node -e "console.log('partial');process.exit(3)"` })
  expect(r.code).toBe(0)
  expect(r.out).toBe('')
  expect(bodies).toHaveLength(1)
})

test('statusline.cjs gives up on a forwarded command that hangs', async () => {
  const { file, bodies } = await fakeServer()
  const r = await run({ PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_STATUSLINE_FORWARD: `node -e "setTimeout(()=>{},60000)"` })
  expect(r.code).toBe(0)
  expect(r.out).toBe('')
  // Its limit is 5 s, against a command that would take 60. Loose, as starting node and bash is slow on a busy machine.
  expect(r.ms).toBeLessThan(30_000)
  expect(bodies).toHaveLength(1)
})

async function realServer(onUsage: (id: string, report: unknown) => void) {
  return startControlServer({ secret: 'sec', endpointFile: join(dir, 'ep.json'), onHook: () => ({}), onRpc: async () => null, onUsage })
}

const postUsage = (port: number, token: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-patchbay-node': 'n1', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })

test('POST /usage with a bad token is refused and reports nothing', async () => {
  const onUsage = vi.fn()
  const s = await realServer(onUsage)
  const res = await postUsage(s.port, 'wrong', { context_window: { used_percentage: 1 } })
  expect(res.status).toBe(401)
  expect(onUsage).not.toHaveBeenCalled()
  await s.close()
})

test('POST /usage hands over the parsed report for that node', async () => {
  const onUsage = vi.fn()
  const s = await realServer(onUsage)
  const res = await postUsage(s.port, tokenFor('sec', 'n1'), { context_window: { used_percentage: 12 }, junk: 1 })
  expect(res.status).toBe(200)
  expect(onUsage).toHaveBeenCalledWith('n1', { contextPercent: 12 })
  await s.close()
})
