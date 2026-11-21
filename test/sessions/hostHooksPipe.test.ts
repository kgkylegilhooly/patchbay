import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { SessionSpec } from '../../src/shared/contract'
import { createBackgroundHost, type BackgroundHost } from '../../src/main/sessions/backgroundHost'
import { SessionStartError, type PtyHost } from '../../src/main/sessions/host'
import { connectToHost } from '../../src/main/sessions/hostClient'
import { startHostHooks, type HostHooks } from '../../src/main/sessions/hostHooks'
import { HOST_PROTOCOL, type HostedSession } from '../../src/main/sessions/hostProtocol'
import { startHostServer, type HostServer } from '../../src/main/sessions/hostServer'
import { takeMissedHooks } from '../../src/main/sessions/missedHooks'
import { removeTemp } from '../support/realProcess'

/** Sessions with no PTY behind them. */
function fakeSessions(): PtyHost {
  const running = new Set<string>()
  return {
    start: (spec: SessionSpec) => void running.add(spec.nodeId),
    write: () => {},
    resize: () => {},
    kill: async (id) => void running.delete(id),
    pid: (id) => (running.has(id) ? 4242 : null),
    isRunning: (id) => running.has(id),
    snapshot: () => ({ data: '', seq: 0 }),
    onOutput: () => {},
    onExit: () => {},
    list: () => [...running].map((id): HostedSession => ({ id, pid: 4242, running: true, exitCode: null, exitedAt: null })),
    forget: (id) => void running.delete(id),
    pause: () => {},
    resume: () => {}
  }
}

const SECRET = 'host-secret'
let dir = ''
let server: HostServer | null = null
let hooks: HostHooks | null = null
let app: BackgroundHost | null = null

afterEach(async () => {
  await app?.detach()
  await server?.close()
  await hooks?.close()
  app = server = hooks = null
  await removeTemp(dir)
})

async function setUp(opts: { serveHooks?: boolean } = {}): Promise<{ pipe: string }> {
  dir = mkdtempSync(join(tmpdir(), 'patchbay pipe hooks '))
  const pipe = `\\\\.\\pipe\\patchbay-hooks-test-${randomUUID()}`
  hooks = opts.serveHooks === false ? null : await startHostHooks({ journalDir: join(dir, 'missed'), replyLimitMs: 300, holdMs: 100 })
  server = await startHostServer({ pipe, secret: SECRET, protocol: HOST_PROTOCOL, version: 't', startedAt: Date.now(), sessions: fakeSessions(), onStopRequested: () => {}, ...(hooks ? { hooks } : {}) })
  return { pipe }
}

function appFor(pipe: string): BackgroundHost {
  return createBackgroundHost({ pipe, secret: SECRET, spawnHost: () => {}, createLocal: () => fakeSessions(), startTimeoutMs: 2000 })
}

const spec = (nodeId: string, over: Partial<SessionSpec> = {}): SessionSpec => ({ nodeId, file: 'claude.exe', args: [], cwd: dir, env: { PATCHBAY_TOKEN: `tok-${nodeId}`, PATCHBAY_NODE_ID: nodeId }, ...over })

function post(port: number, event: string, nodeId: string, payload: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const text = JSON.stringify({ hook_event_name: event, session_id: 's', ...payload })
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path: `/hook/${event}`, headers: { 'content-type': 'application/json', 'x-patchbay-node': nodeId, authorization: `Bearer tok-${nodeId}` } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }))
      }
    )
    req.on('error', reject)
    req.end(text)
  })
}

test('a session started in the host has its hooks served there and handled by the app, permission answers included', async () => {
  const { pipe } = await setUp()
  app = appFor(pipe)
  await app.connect()
  const port = app.hookPort()
  expect(port).toBe(hooks?.port)
  // Its token comes from its own environment, given to the host as it starts.
  expect((await post(port!, 'Stop', 'n1')).status).toBe(401)
  await app.start(spec('n1', { hookPort: port! }))
  const seen: string[] = []
  app.serveHooks(async (id, payload) => {
    seen.push(`${id}:${payload.hook_event_name}`)
    return payload.hook_event_name === 'PermissionRequest' ? { decision: 'allow' } : {}
  })
  expect(await post(port!, 'UserPromptSubmit', 'n1')).toEqual({ status: 200, body: {} })
  expect((await post(port!, 'PermissionRequest', 'n1', { tool_name: 'Bash', tool_input: { command: 'ls' } })).body).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
  })
  expect(seen).toEqual(['n1:UserPromptSubmit', 'n1:PermissionRequest'])
})

test("events before the app is ready to handle them wait for it, in order, and Claude isn't kept waiting", async () => {
  const { pipe } = await setUp()
  app = appFor(pipe)
  await app.connect()
  await app.start(spec('n1'))
  const started = Date.now()
  await post(app.hookPort()!, 'UserPromptSubmit', 'n1')
  await post(app.hookPort()!, 'Stop', 'n1')
  expect(Date.now() - started).toBeLessThan(2000)
  const seen: string[] = []
  app.serveHooks((_id, payload) => void seen.push(String(payload.hook_event_name)))
  await new Promise((r) => setTimeout(r, 50))
  expect(seen).toEqual(['UserPromptSubmit', 'Stop'])
})

test('with the app gone, events are journalled for the next one, which reads them as it does today', async () => {
  const { pipe } = await setUp()
  app = appFor(pipe)
  await app.connect()
  await app.start(spec('n1'))
  const port = app.hookPort()!
  await app.detach()
  app = null
  await new Promise((r) => setTimeout(r, 100))
  const held = await post(port, 'PermissionRequest', 'n1', { tool_name: 'Bash' })
  // Left to Claude's own prompt, at once.
  expect(held.body).toEqual({})
  await post(port, 'Stop', 'n1')
  await hooks?.flush()
  expect(takeMissedHooks(join(dir, 'missed'), 'n1').map((e) => e.hook_event_name)).toEqual(['PermissionRequest', 'Stop'])
})

test('a host from before hook serving: the app keeps command hooks', async () => {
  const { pipe } = await setUp({ serveHooks: false })
  app = appFor(pipe)
  await app.connect()
  expect(app.info().mode).toBe('background')
  expect(app.hookPort()).toBeNull()
})

test('sessions in the app itself keep command hooks', async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay pipe hooks '))
  app = createBackgroundHost({ pipe: `\\\\.\\pipe\\patchbay-none-${randomUUID()}`, secret: SECRET, spawnHost: () => { throw new Error('no host') }, createLocal: () => fakeSessions() })
  await app.connect()
  expect(app.info().mode).toBe('in-process')
  expect(app.hookPort()).toBeNull()
  // A launch written for a host's port can't run here: its hooks would reach nothing.
  await expect(app.start(spec('n1', { hookPort: 1234 }))).rejects.toBeInstanceOf(SessionStartError)
})

test('a launch written for another host run is refused rather than started with hooks that reach nothing', async () => {
  const { pipe } = await setUp()
  app = appFor(pipe)
  await app.connect()
  await expect(app.start(spec('n1', { hookPort: hooks!.port + 1 }))).rejects.toThrow(/session host changed/)
  expect(app.isRunning('n1')).toBe(false)
})

test('an app from before hook serving gets no hook messages: the journal has them', async () => {
  const { pipe } = await setUp()
  const old = await connectToHost({ pipe, secret: SECRET, protocol: HOST_PROTOCOL })
  if (old.kind !== 'ok') throw new Error(old.kind)
  const messages: string[] = []
  old.connection.onMessage((m) => void messages.push(m.t))
  await old.connection.request('start', { spec: spec('n1') })
  expect((await post(hooks!.port, 'Stop', 'n1')).body).toEqual({})
  await hooks?.flush()
  expect(messages).not.toContain('hook')
  expect(takeMissedHooks(join(dir, 'missed'), 'n1').map((e) => e.hook_event_name)).toEqual(['Stop'])
  old.connection.close()
})
