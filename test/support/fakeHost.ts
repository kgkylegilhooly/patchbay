import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { SessionSpec } from '../../src/shared/contract'
import { createBackgroundHost, type BackgroundHost } from '../../src/main/sessions/backgroundHost'
import { SessionAlreadyRunning, type PtyHost } from '../../src/main/sessions/host'
import { HOST_PROTOCOL, type HostedSession } from '../../src/main/sessions/hostProtocol'
import { startHostServer, type HostServer } from '../../src/main/sessions/hostServer'
import { createSessionBuffer } from '../../src/main/sessions/sessionBuffer'

/**
 * Sessions with no real program behind them, which outlive any one host server, as a host's do when only its
 * connection to the app went away. A test decides what each prints and when it ends.
 */
export function fakeSessions(opts: { onStart?: (spec: SessionSpec) => void } = {}) {
  const sessions = new Map<string, { running: boolean; buffer: ReturnType<typeof createSessionBuffer>; code: number | null; at: number | null }>()
  const outputs: Array<(id: string, data: string, seq: number) => void> = []
  const exits: Array<(id: string, code: number) => void> = []
  const writes: Array<[string, string]> = []
  const specs: SessionSpec[] = []
  let seq = 0
  const finish = (id: string, code: number): void => {
    const s = sessions.get(id)
    if (!s?.running) return
    s.running = false
    s.code = code
    s.at = Date.now()
    for (const cb of exits) cb(id, code)
  }
  const host: PtyHost = {
    start(spec) {
      // The same refusal the real host gives.
      if (sessions.get(spec.nodeId)?.running) throw new SessionAlreadyRunning(spec.nodeId)
      specs.push(spec)
      sessions.set(spec.nodeId, { running: true, buffer: createSessionBuffer(1024 * 1024, spec.initialScrollback ?? ''), code: null, at: null })
      opts.onStart?.(spec)
    },
    write: (id, data) => void writes.push([id, data]),
    resize() {},
    async kill(id) {
      finish(id, -1)
    },
    pid: (id) => (sessions.get(id)?.running ? 4242 : null),
    isRunning: (id) => sessions.get(id)?.running ?? false,
    snapshot: (id) => ({ data: sessions.get(id)?.buffer.read() ?? '', seq }),
    onOutput: (cb) => void outputs.push(cb),
    onExit: (cb) => void exits.push(cb),
    list: () => [...sessions].map(([id, s]): HostedSession => ({ id, pid: s.running ? 4242 : null, running: s.running, exitCode: s.code, exitedAt: s.at })),
    forget: (id) => void sessions.delete(id),
    pause() {},
    resume() {}
  }
  const print = (id: string, data: string): void => {
    sessions.get(id)?.buffer.append(data)
    seq++
    for (const cb of outputs) cb(id, data, seq)
  }
  return { host, print, finish, writes, specs }
}

export const pipeName = (): string => `\\\\.\\pipe\\patchbay-sync-test-${randomUUID()}`

/** Everything made here, undone in reverse. Call from afterEach. */
export const cleanups: Array<() => Promise<void> | void> = []
export async function cleanUp(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c()
}

export async function serve(pipe: string, sessions: PtyHost): Promise<HostServer> {
  const server = await startHostServer({ pipe, secret: 'secret', protocol: HOST_PROTOCOL, version: '1', startedAt: 1, sessions, onStopRequested: () => {} })
  cleanups.push(() => server.close())
  return server
}

export function client(pipe: string): BackgroundHost {
  const app = createBackgroundHost({ pipe, secret: 'secret', spawnHost: () => {}, createLocal: () => fakeSessions().host, startTimeoutMs: 300 })
  cleanups.push(() => app.detach())
  return app
}

/** The app loses its host (to the app it looks gone), then the same host, sessions and all, answers again. */
export async function loseAndComeBack(pipe: string, server: HostServer, sessions: PtyHost, app: BackgroundHost): Promise<HostServer> {
  const lost = vi.fn()
  app.onLost(lost)
  await server.close()
  await vi.waitFor(() => expect(lost).toHaveBeenCalled(), { timeout: 3000 })
  return serve(pipe, sessions)
}
