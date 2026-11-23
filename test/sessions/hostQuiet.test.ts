import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { createBackgroundHost } from '../../src/main/sessions/backgroundHost'
import { createSessionHost, type PtyHost } from '../../src/main/sessions/host'
import { HOST_PROTOCOL } from '../../src/main/sessions/hostProtocol'
import { startHostServer } from '../../src/main/sessions/hostServer'
import type { SessionSpec } from '../../src/shared/contract'
import { usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** A program that prints a numbered line every few milliseconds, then stays open. */
const printer = (nodeId: string, lines: number): SessionSpec => ({
  nodeId,
  file: process.execPath,
  args: ['-e', `let i=0;const t=setInterval(()=>{process.stdout.write('L'+(i++)+String.fromCharCode(10));if(i>=${lines}){clearInterval(t);process.stdout.write('DONE')}},4);setTimeout(()=>{},60000)`],
  cwd: tmpdir(),
  env: process.env as Record<string, string>
})

test('a session no window shows sends all its output, in far fewer pieces, and at once when shown again', async () => {
  const host = createSessionHost()
  cleanups.push(() => Promise.all([host.kill('shown'), host.kill('quiet')]))
  const chunks = new Map<string, string[]>()
  host.onOutput((id, data) => chunks.set(id, [...(chunks.get(id) ?? []), data]))
  host.setQuiet?.(['quiet'])
  host.start(printer('shown', 150))
  host.start(printer('quiet', 150))
  const text = (id: string): string => (chunks.get(id) ?? []).join('')
  await vi.waitFor(() => expect(text('shown')).toContain('DONE'), { timeout: 30_000, interval: 50 })
  await vi.waitFor(() => expect(text('quiet')).toContain('DONE'), { timeout: 30_000, interval: 50 })
  for (const id of ['shown', 'quiet']) for (let i = 0; i < 150; i++) expect(text(id)).toContain(`L${i}\r\n`)
  const shown = chunks.get('shown')?.length ?? 0
  const quiet = chunks.get('quiet')?.length ?? 0
  expect(quiet * 3).toBeLessThan(shown)

  // Shown again: what was waiting goes straight away, not a quarter second later.
  const before = chunks.get('quiet')?.length ?? 0
  host.write('quiet', 'x')
  host.setQuiet?.([])
  expect(host.snapshot('quiet').data).toContain('DONE')
  expect(chunks.get('quiet')?.length ?? 0).toBeGreaterThanOrEqual(before)
})

/** Sessions with nothing behind them, recording what the host server tells them about quiet ones. */
function recordingSessions(): PtyHost & { quiet: string[][]; started: string[] } {
  const quiet: string[][] = []
  const started: string[] = []
  return {
    quiet,
    started,
    start: (spec) => void started.push(spec.nodeId),
    write: () => {},
    resize: () => {},
    kill: async () => {},
    pid: () => 1,
    isRunning: (id) => started.includes(id),
    snapshot: () => ({ data: '', seq: 0 }),
    onOutput: () => {},
    onExit: () => {},
    list: () => started.map((id) => ({ id, pid: 1, running: true, exitCode: null, exitedAt: null })),
    forget: () => {},
    pause: () => {},
    resume: () => {},
    setQuiet: (ids) => void quiet.push(ids)
  }
}

const pipeName = (): string => `\\\\.\\pipe\\patchbay-test-${randomUUID()}`

async function serveOn(pipe: string, sessions: PtyHost) {
  const server = await startHostServer({ pipe, secret: 's', protocol: HOST_PROTOCOL, version: 't', startedAt: 1, sessions, onStopRequested: () => {} })
  cleanups.push(() => server.close())
  return server
}

test('the app tells the host which of its sessions no window shows, and only when that changes', async () => {
  const pipe = pipeName()
  const sessions = recordingSessions()
  await serveOn(pipe, sessions)
  const app = createBackgroundHost({ pipe, secret: 's', spawnHost: () => {}, createLocal: () => recordingSessions(), startTimeoutMs: 300 })
  cleanups.push(() => app.detach())
  await app.connect()
  await app.start({ nodeId: 'a', file: 'x', args: [], cwd: '.', env: {} })
  await app.start({ nodeId: 'b', file: 'x', args: [], cwd: '.', env: {} })
  app.setShown(new Set(['a']))
  await vi.waitFor(() => expect(sessions.quiet.at(-1)).toEqual(['b']))
  const told = sessions.quiet.length
  app.setShown(new Set(['a']))
  app.setShown(new Set(['a', 'zzz']))
  await new Promise((r) => setTimeout(r, 100))
  expect(sessions.quiet.length).toBe(told)
  // No window has said: everything is shown.
  app.setShown(null)
  await vi.waitFor(() => expect(sessions.quiet.at(-1)).toEqual([]))
})

test('with no host running, a quick connect returns while the new host starts, and a full one waits for it', async () => {
  const pipe = pipeName()
  const sessions = recordingSessions()
  let spawnedAt = 0
  const app = createBackgroundHost({
    pipe,
    secret: 's',
    // A slow start, as when a new build first copies its program.
    spawnHost: () => {
      spawnedAt = Date.now()
      setTimeout(() => void serveOn(pipe, sessions), 400)
    },
    createLocal: () => recordingSessions(),
    startTimeoutMs: 5000
  })
  cleanups.push(() => app.detach())
  const started = Date.now()
  const quick = await app.connect({ quick: true })
  expect(quick.mode).toBe('starting')
  expect(Date.now() - started).toBeLessThan(300)
  expect(app.sessions()).toEqual([])
  const full = await app.connect()
  expect(full.mode).toBe('background')
  expect(Date.now() - spawnedAt).toBeGreaterThanOrEqual(350)
  // Once connected, a quick connect is just a connect.
  expect((await app.connect({ quick: true })).mode).toBe('background')
})
