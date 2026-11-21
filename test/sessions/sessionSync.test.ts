import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionSpec } from '../../src/shared/contract'
import { SessionAlreadyRunning } from '../../src/main/sessions/host'
import { cleanUp, client, fakeSessions, loseAndComeBack, pipeName, serve } from '../support/fakeHost'

/**
 * The app and its host disagreeing after a reconnect: the canvas said Exited while the host still ran the program,
 * and Restart then failed with "already running". These run a real pipe between a real client and server, with fake
 * sessions behind it that outlive any one server. See docs/plans/session-sync.md.
 */
const spec = (nodeId: string): SessionSpec => ({ nodeId, file: 'x', args: [], cwd: '.', env: {} })

afterEach(cleanUp)

describe('after the app gave up on a host that was still there', () => {
  test('its sessions count as running again, say so, and take input', async () => {
    const pipe = pipeName()
    const fake = fakeSessions()
    const server = await serve(pipe, fake.host)
    const app = client(pipe)
    const exits: string[] = []
    app.onExit((id) => exits.push(id))
    const revived: string[] = []
    app.onRevive((id) => revived.push(id))
    await app.connect()
    await app.start(spec('t'))
    await loseAndComeBack(pipe, server, fake.host, app)
    expect(exits).toEqual(['t'])
    expect(app.isRunning('t')).toBe(false)

    await app.connect()
    expect(app.isRunning('t')).toBe(true)
    expect(app.pid('t')).toBe(4242)
    expect(revived).toEqual(['t'])
    expect(app.sessions()).toEqual([expect.objectContaining({ id: 't', running: true })])
    app.write('t', 'hi\r')
    await vi.waitFor(() => expect(fake.writes).toEqual([['t', 'hi\r']]))
  })

  test('its views get the whole buffer from a clean slate, then the live stream', async () => {
    const pipe = pipeName()
    const fake = fakeSessions()
    const server = await serve(pipe, fake.host)
    const app = client(pipe)
    const seen: string[] = []
    app.onOutput((_id, data) => seen.push(data))
    await app.connect()
    await app.start(spec('t'))
    await loseAndComeBack(pipe, server, fake.host, app)
    fake.print('t', 'while away\n')
    await app.connect()
    expect(seen.at(-1)).toBe('\x1bcwhile away\n')
    fake.print('t', 'live\n')
    await vi.waitFor(() => expect(seen.at(-1)).toBe('live\n'))
  })

  test('starting it again does not dead-end: it is joined, and the caller is told it was already running', async () => {
    const pipe = pipeName()
    const fake = fakeSessions()
    const server = await serve(pipe, fake.host)
    const app = client(pipe)
    await app.connect()
    await app.start(spec('t'))
    await loseAndComeBack(pipe, server, fake.host, app)
    // Restart, with nothing having reconnected yet: the start itself is what reaches the host again.
    const failure = await app.start(spec('t')).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SessionAlreadyRunning)
    expect(app.isRunning('t')).toBe(true)
    app.write('t', 'x')
    await vi.waitFor(() => expect(fake.writes).toEqual([['t', 'x']]))
  })

  test('the host refusing a start because it already runs that session joins it too', async () => {
    const pipe = pipeName()
    const fake = fakeSessions()
    await serve(pipe, fake.host)
    const app = client(pipe)
    await app.connect()
    // Running in the host, but this app never heard of it: started by a reply that never arrived.
    fake.host.start(spec('t'))
    const failure = await app.start(spec('t')).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SessionAlreadyRunning)
    expect(app.isRunning('t')).toBe(true)
  })

  test('a start whose reply was lost leaves a session the reconnect still finds', async () => {
    const pipe = pipeName()
    let drop: (() => Promise<void>) | null = null
    const fake = fakeSessions({ onStart: () => void drop?.() })
    const server = await serve(pipe, fake.host)
    const app = client(pipe)
    await app.connect()
    // The host spawns it, then the connection goes before the reply does.
    drop = () => server.close()
    const failure = await app.start(spec('t')).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    drop = null
    expect(fake.host.isRunning('t')).toBe(true)
    await vi.waitFor(() => expect(app.info().mode).toBe('stopped'), { timeout: 3000 })
    await serve(pipe, fake.host)
    const revived: string[] = []
    app.onRevive((id) => revived.push(id))
    await app.connect()
    expect(app.isRunning('t')).toBe(true)
    expect(revived).toEqual(['t'])
  })
})

describe('refresh, which checks the mirror against the host itself', () => {
  test('a mirror counted as ended that the host still runs is revived', async () => {
    const pipe = pipeName()
    const fake = fakeSessions()
    const server = await serve(pipe, fake.host)
    const app = client(pipe)
    await app.connect()
    await app.start(spec('t'))
    await loseAndComeBack(pipe, server, fake.host, app)
    const revived: string[] = []
    app.onRevive((id) => revived.push(id))
    // Something else reconnected, such as another session starting.
    await app.start(spec('other'))
    expect(revived).toEqual(['t'])
    expect(await app.refresh()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 't', running: true })]))
    expect(revived).toEqual(['t'])
  })

  test('a mirror still counted as running that the host has ended is marked ended', async () => {
    const pipe = pipeName()
    const fake = fakeSessions()
    await serve(pipe, fake.host)
    const app = client(pipe)
    const exits: Array<[string, number]> = []
    app.onExit((id, code) => exits.push([id, code]))
    await app.connect()
    await app.start(spec('t'))
    // An exit the app never heard of: the host drops the session out from under it.
    fake.host.forget('t')
    await app.refresh()
    expect(exits).toEqual([['t', -1]])
    expect(app.isRunning('t')).toBe(false)
  })

  test('there is nothing to ask with no host, which says so rather than guess', async () => {
    const app = client(pipeName())
    expect(await app.refresh()).toBeNull()
  })
})
