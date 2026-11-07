import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionSpec } from '../../src/shared/contract'
import { createBackgroundHost, type BackgroundHost } from '../../src/main/sessions/backgroundHost'
import { SessionStartError, type PtyHost } from '../../src/main/sessions/host'
import { HOST_PROTOCOL, type HostedSession } from '../../src/main/sessions/hostProtocol'
import { connectToHost } from '../../src/main/sessions/hostClient'
import { startHostServer, type HostServer } from '../../src/main/sessions/hostServer'
import { createSessionBuffer } from '../../src/main/sessions/sessionBuffer'

/** Sessions with no real PTY behind them: the test decides what each one prints. */
function fakeSessions() {
  const sessions = new Map<string, { running: boolean; buffer: ReturnType<typeof createSessionBuffer>; code: number | null; at: number | null }>()
  const outputs: Array<(id: string, data: string, seq: number) => void> = []
  const exits: Array<(id: string, code: number) => void> = []
  const seqs = new Map<string, number>()
  const paused = new Set<string>()
  const writes: Array<[string, string]> = []
  const sizes = new Map<string, { cols: number; rows: number }>()
  const resizes: Array<[string, number, number]> = []
  const finish = (id: string, code: number): void => {
    const s = sessions.get(id)
    if (!s?.running) return
    s.running = false
    s.code = code
    s.at = Date.now()
    for (const cb of exits) cb(id, code)
  }
  const host: PtyHost = {
    start(spec: SessionSpec) {
      if (spec.cwd === 'missing') throw new SessionStartError('cwd-missing', 'Folder not found: missing')
      sessions.set(spec.nodeId, { running: true, buffer: createSessionBuffer(1024 * 1024, spec.initialScrollback ?? ''), code: null, at: null })
    },
    write: (id, data) => void writes.push([id, data]),
    resize(id, cols, rows) {
      resizes.push([id, cols, rows])
      sizes.set(id, { cols, rows })
    },
    async kill(id) {
      finish(id, -1)
    },
    pid: (id) => (sessions.get(id)?.running ? 4242 : null),
    isRunning: (id) => sessions.get(id)?.running ?? false,
    snapshot: (id) => ({ data: sessions.get(id)?.buffer.read() ?? '', seq: seqs.get(id) ?? 0 }),
    onOutput: (cb) => void outputs.push(cb),
    onExit: (cb) => void exits.push(cb),
    list: () => [...sessions].map(([id, s]): HostedSession => ({ id, pid: s.running ? 4242 : null, running: s.running, exitCode: s.code, exitedAt: s.at, size: sizes.get(id) })),
    forget: (id) => void sessions.delete(id),
    pause: (id) => void paused.add(id),
    resume: (id) => void paused.delete(id)
  }
  const print = (id: string, data: string): void => {
    sessions.get(id)?.buffer.append(data)
    const seq = (seqs.get(id) ?? 0) + 1
    seqs.set(id, seq)
    for (const cb of outputs) cb(id, data, seq)
  }
  return { host, print, finish, writes, resizes, paused }
}

const spec = (nodeId: string, extra: Partial<SessionSpec> = {}): SessionSpec => ({ nodeId, file: 'x', args: [], cwd: '.', env: {}, ...extra })

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function pipeName(): string {
  return `\\\\.\\pipe\\patchbay-test-${randomUUID()}`
}

async function serve(pipe: string, opts: { protocol?: number; secret?: string; stallMs?: number; highWaterBytes?: number } = {}) {
  const fake = fakeSessions()
  const onStopRequested = vi.fn()
  const server: HostServer = await startHostServer({
    pipe,
    secret: opts.secret ?? 'secret',
    protocol: opts.protocol ?? HOST_PROTOCOL,
    version: '1.2.3',
    startedAt: 1,
    sessions: fake.host,
    onStopRequested,
    stallMs: opts.stallMs,
    highWaterBytes: opts.highWaterBytes
  })
  cleanups.push(() => server.close())
  return { ...fake, server, onStopRequested }
}

function client(pipe: string, overrides: Partial<Parameters<typeof createBackgroundHost>[0]> = {}): BackgroundHost {
  const app = createBackgroundHost({
    pipe,
    secret: 'secret',
    spawnHost: () => {},
    createLocal: () => fakeSessions().host,
    startTimeoutMs: 300,
    ...overrides
  })
  cleanups.push(() => app.detach())
  return app
}

function collectOutput(app: BackgroundHost): { text: () => string; chunks: Array<{ id: string; data: string; seq: number }> } {
  const chunks: Array<{ id: string; data: string; seq: number }> = []
  app.onOutput((id, data, seq) => chunks.push({ id, data, seq }))
  return { chunks, text: () => chunks.map((c) => c.data).join('') }
}

describe('the handshake', () => {
  test('a wrong secret is refused, and it learns nothing about the host', async () => {
    const pipe = pipeName()
    await serve(pipe, { secret: 'right' })
    expect((await connectToHost({ pipe, secret: 'wrong', protocol: HOST_PROTOCOL })).kind).toBe('refused')
  })

  test('a host that does not hold the secret fails the app\'s side of the check too', async () => {
    const pipe = pipeName()
    await serve(pipe, { secret: 'right' })
    const app = client(pipe, { secret: 'wrong' })
    const info = await app.connect()
    expect(info.mode).toBe('in-process')
  })

  test('nothing listening reads as absent', async () => {
    expect((await connectToHost({ pipe: pipeName(), secret: 's', protocol: 1 })).kind).toBe('absent')
  })

  test('a second host for the same pipe fails, so a profile can only ever have one', async () => {
    const pipe = pipeName()
    await serve(pipe)
    await expect(serve(pipe)).rejects.toThrow()
  })
})

describe('reconnecting', () => {
  test('output from while the app was away arrives once, in order, then the live stream carries on', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const first = client(pipe)
    await first.connect()
    await first.start(spec('t'))
    host.print('t', 'one\n')
    await vi.waitFor(() => expect(first.snapshot('t').data).toBe('one\n'))
    first.detach()
    await vi.waitFor(() => expect(host.server.connected()).toBe(false))

    host.print('t', 'two\n')
    host.print('t', 'three\n')

    const second = client(pipe)
    const seen = collectOutput(second)
    await second.connect()
    expect(second.isRunning('t')).toBe(true)
    expect(second.pid('t')).toBe(4242)
    const snap = second.snapshot('t')
    expect(snap.data).toBe('one\ntwo\nthree\n')
    host.print('t', 'four\n')
    await vi.waitFor(() => expect(seen.text()).toBe('four\n'))
    expect(second.snapshot('t').data).toBe('one\ntwo\nthree\nfour\n')
    expect(seen.chunks[0].seq).toBeGreaterThan(snap.seq)
  })

  test('output arriving during the attach is neither lost nor repeated', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    host.host.start(spec('t'))
    host.print('t', 'before\n')
    const snapshot = host.host.snapshot.bind(host.host)
    // The moment the host takes the snapshot, more output is already on its way.
    host.host.snapshot = (id) => {
      const taken = snapshot(id)
      setImmediate(() => host.print('t', 'after\n'))
      return taken
    }
    const app = client(pipe)
    const seen = collectOutput(app)
    await app.connect()
    await vi.waitFor(() => expect(app.snapshot('t').data).toBe('before\nafter\n'))
    expect(seen.text()).toBe('after\n')
  })

  test('a session that ended while the app was away is reported as ended, with its output', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    host.host.start(spec('t'))
    host.print('t', 'last words\n')
    host.finish('t', 7)
    const app = client(pipe)
    await app.connect()
    expect(app.isRunning('t')).toBe(false)
    expect(app.snapshot('t').data).toBe('last words\n')
    expect(app.sessions()).toEqual([expect.objectContaining({ id: 't', running: false, exitCode: 7 })])
  })

  test('a dropped connection to a host still there recovers, and views get the whole buffer from a clean slate', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe)
    const seen = collectOutput(app)
    const lost = vi.fn()
    app.onLost(lost)
    await app.connect()
    await app.start(spec('t'))
    host.print('t', 'one\n')
    await vi.waitFor(() => expect(seen.text()).toBe('one\n'))

    const other = await connectToHost({ pipe, secret: 'secret', protocol: HOST_PROTOCOL })
    if (other.kind !== 'ok') throw new Error(other.kind)
    other.connection.close() // The newest app wins, so this knocks the first one off.
    host.print('t', 'two\n')

    await vi.waitFor(() => expect(seen.chunks.at(-1)?.data).toBe('\x1bcone\ntwo\n'), { timeout: 3000 })
    expect(app.isRunning('t')).toBe(true)
    expect(lost).not.toHaveBeenCalled()
    const before = seen.chunks.at(-1)?.seq ?? 0
    host.print('t', 'three\n')
    await vi.waitFor(() => expect(seen.chunks.at(-1)?.data).toBe('three\n'))
    expect(seen.chunks.at(-1)?.seq).toBeGreaterThan(before)
  })

  test('a host that really went away ends its sessions and says so', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe, { spawnHost: () => {} })
    const exits: Array<[string, number]> = []
    app.onExit((id, code) => exits.push([id, code]))
    const lost = vi.fn()
    app.onLost(lost)
    await app.connect()
    await app.start(spec('t'))
    await host.server.close()
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(exits).toEqual([['t', -1]])
    expect(app.info().mode).toBe('stopped')
    expect(app.info().problem).toMatch(/stopped unexpectedly/)
  })
})

describe('sessions', () => {
  test('a session counts as running from the moment it is asked for, so it cannot start twice', async () => {
    const pipe = pipeName()
    await serve(pipe)
    const app = client(pipe)
    await app.connect()
    const starting = app.start(spec('t'))
    expect(app.isRunning('t')).toBe(true)
    await expect(app.start(spec('t'))).rejects.toThrow(/already running/)
    await starting
  })

  test('a failed start keeps its reason and leaves the previous output alone', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe)
    await app.connect()
    await app.start(spec('t'))
    host.print('t', 'kept\n')
    await vi.waitFor(() => expect(app.snapshot('t').data).toBe('kept\n'))
    host.finish('t', 0)
    await vi.waitFor(() => expect(app.isRunning('t')).toBe(false))
    const failure = await app.start(spec('t', { cwd: 'missing' })).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SessionStartError)
    expect((failure as SessionStartError).reason).toBe('cwd-missing')
    expect(app.isRunning('t')).toBe(false)
    expect(app.snapshot('t').data).toBe('kept\n')
  })

  test('a seed is in the mirror from the start, and a restart keeps counting for views already attached', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe)
    const seen = collectOutput(app)
    await app.connect()
    await app.start(spec('t'))
    host.print('t', 'a')
    await vi.waitFor(() => expect(seen.chunks).toHaveLength(1))
    host.finish('t', 0)
    await vi.waitFor(() => expect(app.isRunning('t')).toBe(false))
    await app.start(spec('t', { initialScrollback: 'old\n' }))
    expect(app.snapshot('t').data).toBe('old\n')
    host.print('t', 'b')
    await vi.waitFor(() => expect(seen.chunks).toHaveLength(2))
    expect(seen.chunks[1].seq).toBe(2)
  })

  test('keys and sizes reach the host, and the last size goes with a session that starts later', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe)
    await app.connect()
    app.resize('t', 100, 30)
    await app.start(spec('t'))
    expect(host.resizes).toEqual([['t', 100, 30]])
    app.write('t', 'ls\r')
    await vi.waitFor(() => expect(host.writes).toEqual([['t', 'ls\r']]))
  })

  test('killing ends it, reports the exit, and forgetting drops it', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe)
    const exits: string[] = []
    app.onExit((id) => exits.push(id))
    await app.connect()
    await app.start(spec('t'))
    await app.kill('t')
    expect(exits).toEqual(['t'])
    app.forget('t')
    await vi.waitFor(() => expect(host.host.list()).toEqual([]))
    expect(app.sessions()).toEqual([])
  })
})

describe('repainting after a reattach', () => {
  async function adopted(print?: string) {
    const pipe = pipeName()
    const host = await serve(pipe)
    host.host.start(spec('t'))
    if (print) host.print('t', print)
    const app = client(pipe)
    await app.connect()
    return { host, app }
  }

  test('a plain shell is left alone, because a redraw would repeat what is in its history', async () => {
    const { host, app } = await adopted('hello\n')
    app.resize('t', 80, 24)
    await vi.waitFor(() => expect(host.resizes).toEqual([['t', 80, 24]]))
    await new Promise((r) => setTimeout(r, 150))
    expect(host.resizes).toHaveLength(1)
  })

  test('a new view reporting the size the session already has causes no resize, which would repeat its screen', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    host.host.start(spec('t'))
    host.host.resize('t', 80, 24)
    host.resizes.length = 0
    const app = client(pipe)
    await app.connect()
    app.resize('t', 80, 24)
    await new Promise((r) => setTimeout(r, 100))
    expect(host.resizes).toEqual([])
    app.resize('t', 81, 24)
    await vi.waitFor(() => expect(host.resizes).toEqual([['t', 81, 24]]))
  })

  test('a program marked as drawing its own screen gets a real size change, then its true size', async () => {
    const { host, app } = await adopted()
    app.repaintOnNextResize('t')
    app.resize('t', 80, 24)
    await vi.waitFor(() => expect(host.resizes).toEqual([['t', 79, 24], ['t', 80, 24]]))
  })

  test('a full-screen program is noticed without being marked', async () => {
    const { host, app } = await adopted('\x1b[?1049h')
    app.resize('t', 80, 24)
    await vi.waitFor(() => expect(host.resizes).toEqual([['t', 79, 24], ['t', 80, 24]]))
  })

  test('it only happens once', async () => {
    const { host, app } = await adopted('\x1b[?1049h')
    app.resize('t', 80, 24)
    await vi.waitFor(() => expect(host.resizes).toHaveLength(2))
    app.resize('t', 90, 24)
    await vi.waitFor(() => expect(host.resizes.at(-1)).toEqual(['t', 90, 24]))
    expect(host.resizes).toHaveLength(3)
  })
})

describe('another version', () => {
  test('is never stopped without being asked, and nothing can start until the owner chooses', async () => {
    const pipe = pipeName()
    const host = await serve(pipe, { protocol: HOST_PROTOCOL - 1 })
    host.host.start(spec('old'))
    const app = client(pipe)
    const info = await app.connect()
    expect(info.mode).toBe('other-version')
    expect(info.running).toBe(1)
    expect(info.protocol).toBe(HOST_PROTOCOL - 1)
    expect(info.problem).toMatch(/1 session/)
    expect(host.onStopRequested).not.toHaveBeenCalled()
    expect(host.host.isRunning('old')).toBe(true)
    await expect(app.start(spec('new'))).rejects.toThrow(/older session host/)
  })

  test('can only be stopped: a limited connection gets at nothing else', async () => {
    const pipe = pipeName()
    const host = await serve(pipe, { protocol: HOST_PROTOCOL - 1 })
    host.host.start(spec('old'))
    const result = await connectToHost({ pipe, secret: 'secret', protocol: HOST_PROTOCOL })
    if (result.kind !== 'other-protocol') throw new Error(result.kind)
    cleanups.push(() => result.connection.close())
    await expect(result.connection.request('list')).rejects.toThrow(/can only be stopped/)
    await expect(result.connection.request('kill', { id: 'old' })).rejects.toThrow()
    result.connection.send({ t: 'w', id: 'old', d: 'rm -rf\r' })
    await result.connection.request('stop-host')
    await vi.waitFor(() => expect(host.onStopRequested).toHaveBeenCalledOnce())
    expect(host.writes).toEqual([])
  })
})

describe('when no host can run', () => {
  test('sessions run in the app instead, and it says why', async () => {
    const local = fakeSessions()
    const spawnHost = vi.fn()
    const app = client(pipeName(), { spawnHost, createLocal: () => local.host, explainFailure: () => 'node-pty would not load' })
    const seen = collectOutput(app)
    const info = await app.connect()
    expect(spawnHost).toHaveBeenCalledOnce()
    expect(info.mode).toBe('in-process')
    expect(info.problem).toMatch(/end when it quits/)
    expect(info.problem).toMatch(/node-pty would not load/)
    await app.start(spec('t'))
    expect(app.isRunning('t')).toBe(true)
    expect(app.info().running).toBe(1)
    local.print('t', 'still works')
    expect(seen.text()).toBe('still works')
    expect(app.snapshot('t')).toEqual({ data: 'still works', seq: 1 })
    app.write('t', 'x')
    expect(local.writes).toEqual([['t', 'x']])
  })

  test('a spawn that throws falls back straight away', async () => {
    const spawnHost = vi.fn(() => {
      throw new Error('no such file')
    })
    const info = await client(pipeName(), { spawnHost }).connect()
    expect(info.mode).toBe('in-process')
    expect(info.problem).toMatch(/no such file/)
  })
})

describe('stopping and leaving', () => {
  test('detaching leaves sessions running', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    const app = client(pipe)
    await app.connect()
    await app.start(spec('t'))
    await app.detach()
    await vi.waitFor(() => expect(host.server.connected()).toBe(false))
    expect(host.host.isRunning('t')).toBe(true)
    expect(host.onStopRequested).not.toHaveBeenCalled()
  })

  test('stopping asks the host to end, and every session reads as ended', async () => {
    const pipe = pipeName()
    const host = await serve(pipe)
    host.onStopRequested.mockImplementation(() => void host.server.close())
    const app = client(pipe)
    const exits: string[] = []
    app.onExit((id) => exits.push(id))
    const lost = vi.fn()
    app.onLost(lost)
    await app.connect()
    await app.start(spec('t'))
    await app.stopHost()
    expect(host.onStopRequested).toHaveBeenCalledOnce()
    expect(exits).toEqual(['t'])
    expect(app.info().mode).toBe('stopped')
    expect(lost).not.toHaveBeenCalled()
  })
})

describe('backpressure', () => {
  test('a client that keeps up never pauses anything', async () => {
    const pipe = pipeName()
    const host = await serve(pipe, { highWaterBytes: 1024 * 1024 })
    const app = client(pipe)
    await app.connect()
    await app.start(spec('t'))
    host.print('t', 'x'.repeat(1000))
    await vi.waitFor(() => expect(app.snapshot('t').data.length).toBe(1000))
    expect(host.paused.size).toBe(0)
  })

  test('with no app connected nothing waits: the buffer takes it', async () => {
    const pipe = pipeName()
    const host = await serve(pipe, { highWaterBytes: 1 })
    host.host.start(spec('t'))
    host.print('t', 'x'.repeat(100000))
    expect(host.paused.size).toBe(0)
  })

  test('a noisy session pauses once its output backs up, and carries on once it clears', async () => {
    const pipe = pipeName()
    const host = await serve(pipe, { highWaterBytes: 1 })
    const app = client(pipe)
    await app.connect()
    await app.start(spec('t'))
    host.print('t', 'x'.repeat(4 * 1024 * 1024))
    expect(host.paused.has('t')).toBe(true)
    await vi.waitFor(() => expect(host.paused.size).toBe(0), { timeout: 5000 })
    await vi.waitFor(() => expect(app.snapshot('t').data.length).toBeGreaterThan(0))
    expect(host.host.isRunning('t')).toBe(true)
  })
})
