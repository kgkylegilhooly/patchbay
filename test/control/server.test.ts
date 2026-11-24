import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadOrCreateSecret, RpcRefusal, startControlServer, tokenFor } from '../../src/main/control/server'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const HOOK = resolve('resources/hook.cjs')
const SECRET = 'test-secret'

let dir: string
let endpointFile: string
const closers: Array<() => Promise<void>> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay control '))
  endpointFile = join(dir, 'endpoint.json')
})

afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()))
  await removeTemp(dir)
})

type Handlers = Partial<Parameters<typeof startControlServer>[0]>

async function server(handlers: Handlers = {}) {
  const s = await startControlServer({
    secret: SECRET,
    endpointFile,
    onHook: vi.fn(async () => ({})),
    onRpc: vi.fn(async () => 'ok'),
    ...handlers
  })
  closers.push(() => s.close())
  return s
}

function post(port: number, path: string, nodeId: string, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'x-patchbay-node': nodeId, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

interface HookRun {
  code: number | null
  stdout: string
  ms: number
}

/** Runs the real hook script with this env, feeding `input` on stdin. */
function runHook(input: unknown, env: Record<string, string>, event = 'Stop'): Promise<HookRun> {
  const started = Date.now()
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK, event], { env: { ...process.env, ...env } })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout, ms: Date.now() - started }))
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}

const hookEnv = (nodeId = 'node-1'): Record<string, string> => ({
  PATCHBAY_ENDPOINT_FILE: endpointFile,
  PATCHBAY_NODE_ID: nodeId,
  PATCHBAY_TOKEN: tokenFor(SECRET, nodeId)
})

test('tokenFor is an HMAC-SHA256 hex digest that differs per node and per secret', () => {
  const t = tokenFor('s', 'a')
  expect(t).toMatch(/^[0-9a-f]{64}$/)
  expect(tokenFor('s', 'a')).toBe(t)
  expect(tokenFor('s', 'b')).not.toBe(t)
  expect(tokenFor('other', 'a')).not.toBe(t)
})

test('loadOrCreateSecret returns the same secret on a second call', () => {
  const file = join(dir, 'nested', 'secret')
  const first = loadOrCreateSecret(file)
  expect(first.length).toBeGreaterThanOrEqual(32)
  expect(loadOrCreateSecret(file)).toBe(first)
  expect(readFileSync(file, 'utf8').trim()).toBe(first)
})

test('rpc with the right token reaches the handler with the caller, verb and args', async () => {
  const onRpc = vi.fn(async () => ({ hello: 1 }))
  const s = await server({ onRpc })
  const res = await post(s.port, '/rpc', 'a', tokenFor(SECRET, 'a'), { verb: 'list', args: { x: 1 } })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ result: { hello: 1 } })
  expect(onRpc).toHaveBeenCalledWith('a', 'list', { x: 1 }, expect.any(AbortSignal))
})

test('rpc with the wrong token returns 401 and no handler runs', async () => {
  const onRpc = vi.fn(async () => 'x')
  const onHook = vi.fn(async () => ({}))
  const s = await server({ onRpc, onHook })
  expect((await post(s.port, '/rpc', 'a', 'nope', { verb: 'list' })).status).toBe(401)
  expect((await post(s.port, '/hook', 'a', 'nope', {})).status).toBe(401)
  const bare = await fetch(`http://127.0.0.1:${s.port}/rpc`, { method: 'POST', body: '{}' })
  expect(bare.status).toBe(401)
  expect(onRpc).not.toHaveBeenCalled()
  expect(onHook).not.toHaveBeenCalled()
})

test("rpc with one node's token and another node's id returns 401", async () => {
  const onRpc = vi.fn(async () => 'x')
  const s = await server({ onRpc })
  const res = await post(s.port, '/rpc', 'victim', tokenFor(SECRET, 'attacker'), { verb: 'list' })
  expect(res.status).toBe(401)
  expect(onRpc).not.toHaveBeenCalled()
})

test('a thrown RpcRefusal becomes 400 with its message', async () => {
  const s = await server({
    onRpc: async () => {
      throw new RpcRefusal('not linked to n2')
    }
  })
  const res = await post(s.port, '/rpc', 'a', tokenFor(SECRET, 'a'), { verb: 'read' })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'not linked to n2' })
})

test('any other handler error is a 500 that does not leak its message', async () => {
  const s = await server({
    onRpc: async () => {
      throw new Error('secret detail')
    }
  })
  const res = await post(s.port, '/rpc', 'a', tokenFor(SECRET, 'a'), { verb: 'read' })
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain('secret detail')
})

test('a body over 1 MiB is rejected and no handler runs', async () => {
  const onHook = vi.fn(async () => ({}))
  const s = await server({ onHook })
  const res = await post(s.port, '/hook', 'a', tokenFor(SECRET, 'a'), { pad: 'x'.repeat(1024 * 1024 + 10) })
  expect(res.status).toBe(413)
  expect(onHook).not.toHaveBeenCalled()
})

test('malformed JSON is a 400 and no handler runs', async () => {
  const onHook = vi.fn(async () => ({}))
  const s = await server({ onHook })
  const res = await fetch(`http://127.0.0.1:${s.port}/hook`, {
    method: 'POST',
    headers: { 'x-patchbay-node': 'a', authorization: `Bearer ${tokenFor(SECRET, 'a')}` },
    body: '{not json'
  })
  expect(res.status).toBe(400)
  expect(onHook).not.toHaveBeenCalled()
})

test('other paths and methods are 404', async () => {
  const s = await server()
  expect((await post(s.port, '/other', 'a', tokenFor(SECRET, 'a'), {})).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${s.port}/rpc`)).status).toBe(404)
})

test('server binds to 127.0.0.1', async () => {
  const s = await server()
  expect(s.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: s.port })
})

test('the endpoint file holds the port once listening, with no temp file left over', async () => {
  const s = await server()
  expect(JSON.parse(readFileSync(endpointFile, 'utf8'))).toEqual({ port: s.port, pid: process.pid })
  expect(existsSync(endpointFile + '.tmp')).toBe(false)
})

test('hook.cjs posts stdin JSON with its identity and prints nothing', async () => {
  const onHook = vi.fn(async () => ({}))
  await server({ onHook })
  const run = await runHook({ hook_event_name: 'Stop', session_id: 's1' }, hookEnv())
  expect(run.code).toBe(0)
  expect(run.stdout).toBe('')
  expect(onHook).toHaveBeenCalledTimes(1)
  const [nodeId, payload] = onHook.mock.calls[0] as unknown as [string, Record<string, unknown>]
  expect(nodeId).toBe('node-1')
  expect(payload).toMatchObject({ hook_event_name: 'Stop', session_id: 's1' })
})

test('hook.cjs drops a large tool response rather than lose the status event', async () => {
  const onHook = vi.fn(async () => ({}))
  await server({ onHook })
  const run = await runHook(
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'x'.repeat(2 * 1024 * 1024) },
    hookEnv()
  )
  expect(run.code).toBe(0)
  expect(onHook).toHaveBeenCalledTimes(1)
})

test('hook.cjs exits 0 quickly when the server is unreachable', async () => {
  // Claim a port, then free it, so the endpoint file names a port nobody listens on.
  const port = await new Promise<number>((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port
      probe.close(() => done(p))
    })
  })
  writeFileSync(endpointFile, JSON.stringify({ port }))
  const run = await runHook({ hook_event_name: 'Stop' }, hookEnv())
  expect(run.code).toBe(0)
  expect(run.stdout).toBe('')
  // It gave up on the port by itself and kept the event for the app. The bound is loose on purpose: starting node
  // alone can take seconds on a busy machine, and what this catches is a hook left waiting.
  expect(readFileSync(join(dir, 'missed', 'node-1.jsonl'), 'utf8')).toMatch(/"hook_event_name":"Stop"/)
  expect(run.ms).toBeLessThan(10_000)
})

test('hook.cjs exits 0 within its limit when the server accepts but never answers', async () => {
  let arrived = 0
  let answered = false
  await server({
    onHook: () => {
      arrived = Date.now()
      return new Promise(() => {}).finally(() => (answered = true))
    }
  })
  const run = await runHook({ hook_event_name: 'Stop' }, hookEnv())
  expect(run.code).toBe(0)
  // It left on its own, with the request still unanswered. Timed from the request, not from starting node, which on a
  // busy machine is slow by itself; its limit is 1.5 s, and a hook that waited would never end.
  expect(arrived).toBeGreaterThan(0)
  expect(answered).toBe(false)
  expect(Date.now() - arrived).toBeLessThan(10_000)
})

test('hook.cjs exits 0 when the endpoint file is missing, stdin is junk or env is absent', async () => {
  expect((await runHook({ hook_event_name: 'Stop' }, hookEnv())).code).toBe(0)
  await server()
  expect((await runHook('not json at all', hookEnv())).code).toBe(0)
  expect((await runHook({}, { PATCHBAY_ENDPOINT_FILE: '', PATCHBAY_NODE_ID: '', PATCHBAY_TOKEN: '' })).code).toBe(0)
})

test('hook.cjs reaches a restarted server on a new port using the same token', async () => {
  const first = vi.fn(async () => ({}))
  const a = await server({ onHook: first })
  await runHook({ hook_event_name: 'Stop' }, hookEnv())
  expect(first).toHaveBeenCalledTimes(1)
  await a.close()

  const second = vi.fn(async () => ({}))
  const secret = SECRET // the same secret as the first launch, as loadOrCreateSecret gives
  const b = await startControlServer({ secret, endpointFile, onHook: second, onRpc: async () => null })
  closers.push(() => b.close())
  const run = await runHook({ hook_event_name: 'Stop' }, hookEnv())
  expect(run.code).toBe(0)
  expect(second).toHaveBeenCalledTimes(1)
})

test.each([['a string'], [[1, 2]], [5]])('rpc args that are not an object are a 400: %j', async (args) => {
  const onRpc = vi.fn(async () => 'x')
  const s = await server({ onRpc })
  const res = await post(s.port, '/rpc', 'a', tokenFor(SECRET, 'a'), { verb: 'list', args })
  expect(res.status).toBe(400)
  expect(onRpc).not.toHaveBeenCalled()
})

test("an rpc's signal aborts when the caller hangs up before the answer, and not once it's answered", async () => {
  let held: AbortSignal | undefined
  const answered: AbortSignal[] = []
  const s = await server({
    onRpc: vi.fn(async (_caller: string, verb: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      if (verb === 'list') return answered.push(signal) && 'ok'
      held = signal
      return new Promise((done) => signal.addEventListener('abort', () => done('late')))
    })
  })
  await post(s.port, '/rpc', 'a', tokenFor(SECRET, 'a'), { verb: 'list', args: {} })
  const hangUp = new AbortController()
  const waiting = fetch(`http://127.0.0.1:${s.port}/rpc`, {
    method: 'POST',
    headers: { 'x-patchbay-node': 'a', authorization: `Bearer ${tokenFor(SECRET, 'a')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'wait', args: {} }),
    signal: hangUp.signal
  }).catch(() => 'hung up')
  await vi.waitFor(() => expect(held).toBeDefined())
  hangUp.abort()
  expect(await waiting).toBe('hung up')
  await vi.waitFor(() => expect(held!.aborted).toBe(true))
  expect(answered[0].aborted).toBe(false)
})
