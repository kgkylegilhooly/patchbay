import type { HostInfo, SessionHost, SessionSpec } from '../../shared/contract'
import { SessionStartError, type PtyHost } from './host'
import { connectToHost, HostRequestError, type ConnectResult, type HostConnection, type HostWelcome } from './hostClient'
import { HOST_PROTOCOL, type HostedSession, type HostMessage } from './hostProtocol'
import { createSessionBuffer, type SessionBuffer } from './sessionBuffer'

const DEFAULT_BUFFER_BYTES = 1024 * 1024
/** Long enough for a slow disk to load the host for the first time after a reboot. */
const START_TIMEOUT_MS = 15000
const RETRY_MS = 100
/** A dropped connection to a host that's still there comes back at once. */
const RECONNECT_TRIES = 3
const RECONNECT_GAP_MS = 300
/** The host's own limit on stopping is 5 s. */
const STOP_WAIT_MS = 8000
/** Closing a pipe takes a moment. Exiting the process before it has can hang the exit. */
const DETACH_WAIT_MS = 2000
/** How long the program sees the narrower window, which is long enough to notice and short enough not to show. */
const NUDGE_MS = 80
/** Clears the screen and history of a view that's about to be sent the whole buffer again. */
const FULL_RESET = '\x1bc'

/** The app's copy of a session in the host, so everything the app asks can be answered at once. */
interface Mirror {
  running: boolean
  pid: number | null
  buffer: SessionBuffer
  exitCode: number | null
  exitedAt: number | null
  /** Holds what arrives while this mirror is being filled in, in order. */
  queue: Array<() => void> | null
  /** The next resize should make the program redraw itself. */
  repaint: boolean
  /** It came from the host rather than from this launch, so its program may need telling to redraw. */
  adopted: boolean
  /** What the host last told its program. */
  size?: { cols: number; rows: number }
}

export interface BackgroundHost extends SessionHost {
  start(spec: SessionSpec): Promise<void>
  /** Reaches this profile's host, starting one if needed. Falls back to running sessions in the app. Never rejects. */
  connect(): Promise<HostInfo>
  info(): HostInfo
  onInfo(cb: (info: HostInfo) => void): void
  /** What the host was already running or holding when this app connected, and what's happened since. */
  sessions(): HostedSession[]
  /** Drops an ended session's record. */
  forget(id: string): void
  /** A program that draws its own screen needs a real size change to redraw it. */
  repaintOnNextResize(id: string): void
  /** Lets go of the host and leaves its sessions running. Resolves once the connection has really closed. */
  detach(): Promise<void>
  /** Ends the host and every session in it. In-process sessions are simply ended. */
  stopHost(): Promise<void>
  /** The host went away with sessions in it, without anybody asking. */
  onLost(cb: () => void): void
}

export interface BackgroundHostOptions {
  pipe: string
  secret: string
  /** Throws if it can't even try. */
  spawnHost(): void
  /** Sessions in the app itself, for when no host can run. */
  createLocal(): PtyHost
  /** Whatever the host left to explain why it didn't start. */
  explainFailure?(): string | undefined
  protocol?: number
  startTimeoutMs?: number
  bufferBytes?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createBackgroundHost(opts: BackgroundHostOptions): BackgroundHost {
  const protocol = opts.protocol ?? HOST_PROTOCOL
  const bufferBytes = opts.bufferBytes ?? DEFAULT_BUFFER_BYTES
  const startTimeout = opts.startTimeoutMs ?? START_TIMEOUT_MS
  const mirrors = new Map<string, Mirror>()
  /** Counted here rather than by the host, so a view's position survives the host itself changing. */
  const seqs = new Map<string, number>()
  const sizes = new Map<string, { cols: number; rows: number }>()
  const outputListeners: Array<(id: string, data: string, seq: number) => void> = []
  const exitListeners: Array<(id: string, code: number) => void> = []
  const infoListeners: Array<(info: HostInfo) => void> = []
  const lostListeners: Array<() => void> = []

  let connection: HostConnection | null = null
  let local: PtyHost | null = null
  let welcome: HostWelcome | null = null
  let mode: HostInfo['mode'] = 'stopped'
  let problem: string | undefined
  let leaving = false
  let connecting: Promise<void> | null = null

  const running = (): number => {
    if (mode === 'other-version') return welcome?.running ?? 0
    return [...mirrors.values()].filter((m) => m.running).length + (local?.list().filter((s) => s.running).length ?? 0)
  }

  const info = (): HostInfo => ({
    mode,
    running: running(),
    expectedProtocol: protocol,
    ...(problem ? { problem } : {}),
    ...(welcome && connection ? { pid: welcome.pid, version: welcome.version, protocol: welcome.protocol, startedAt: welcome.startedAt } : {})
  })

  const changed = (): void => {
    const now = info()
    for (const cb of infoListeners) cb(now)
  }

  const setMode = (next: HostInfo['mode'], why?: string): void => {
    mode = next
    problem = why
    changed()
  }

  const emitOutput = (id: string, data: string): void => {
    const seq = (seqs.get(id) ?? 0) + 1
    seqs.set(id, seq)
    for (const cb of outputListeners) cb(id, data, seq)
  }

  const markExited = (id: string, mirror: Mirror, code: number, at = Date.now()): void => {
    if (!mirror.running) return
    mirror.running = false
    mirror.pid = null
    mirror.exitCode = code
    mirror.exitedAt = at
    for (const cb of exitListeners) cb(id, code)
    changed()
  }

  const handleMessage = (message: HostMessage): void => {
    if (message.t === 'o') {
      const mirror = mirrors.get(message.id)
      if (!mirror) return
      const apply = (): void => {
        mirror.buffer.append(message.d)
        emitOutput(message.id, message.d)
      }
      if (mirror.queue) mirror.queue.push(apply)
      else apply()
    } else if (message.t === 'x') {
      const mirror = mirrors.get(message.id)
      if (!mirror) return
      const apply = (): void => markExited(message.id, mirror, message.code)
      if (mirror.queue) mirror.queue.push(apply)
      else apply()
    }
  }

  /** Fills a mirror from the host's buffer and joins its live output, with nothing lost or repeated. */
  const attach = async (conn: HostConnection, session: HostedSession, reset: boolean): Promise<void> => {
    const mirror: Mirror = mirrors.get(session.id) ?? {
      running: session.running,
      pid: session.pid,
      buffer: createSessionBuffer(bufferBytes),
      exitCode: session.exitCode,
      exitedAt: session.exitedAt,
      queue: null,
      repaint: false,
      adopted: session.running,
      size: session.size
    }
    mirrors.set(session.id, mirror)
    mirror.queue = []
    const { data } = (await conn.request('attach', { id: session.id })) as { data: string }
    mirror.buffer = createSessionBuffer(bufferBytes, data)
    mirror.pid = session.pid
    if (reset) emitOutput(session.id, `${FULL_RESET}${data}`)
    const queued = mirror.queue
    mirror.queue = null
    for (const apply of queued) apply()
    // The host's record is the truth, for one that ended while nobody was connected.
    if (!session.running && mirror.running) markExited(session.id, mirror, session.exitCode ?? -1, session.exitedAt ?? undefined)
  }

  const wire = (conn: HostConnection): void => {
    connection = conn
    welcome = conn.welcome
    conn.onMessage(handleMessage)
    conn.onClose(() => {
      if (connection !== conn) return
      connection = null
      void connectionLost()
    })
  }

  const useLocal = (why: string): void => {
    if (!local) {
      local = opts.createLocal()
      local.onOutput((id, data) => emitOutput(id, data))
      local.onExit((id, code) => {
        for (const cb of exitListeners) cb(id, code)
        changed()
      })
    }
    setMode('in-process', why)
  }

  const inProcessWhy = (detail: string): string =>
    `Patchbay couldn't use its background session host, so sessions are running inside the app and end when it quits. ${detail}`

  const establish = async (): Promise<void> => {
    setMode('starting')
    const deadline = Date.now() + startTimeout
    let spawned = false
    for (;;) {
      const result: ConnectResult = await connectToHost({ pipe: opts.pipe, secret: opts.secret, protocol })
      if (result.kind === 'ok') {
        wire(result.connection)
        const list = (await result.connection.request('list')) as HostedSession[]
        await Promise.all(list.map((session) => attach(result.connection, session, false)))
        setMode('background')
        return
      }
      if (result.kind === 'other-protocol') {
        wire(result.connection)
        setMode('other-version', `A session host from another version of Patchbay is still running, with ${result.connection.welcome.running} session${result.connection.welcome.running === 1 ? '' : 's'} in it. This version can't reconnect to them.`)
        return
      }
      if (result.kind === 'refused') {
        useLocal(inProcessWhy("A host is already running for this profile, but it doesn't accept this profile's key. It ends by itself within minutes, or you can end \"Patchbay session host\" in Task Manager."))
        return
      }
      if (!spawned) {
        spawned = true
        try {
          opts.spawnHost()
        } catch (e) {
          useLocal(inProcessWhy(String(e)))
          return
        }
      }
      if (Date.now() >= deadline) {
        const detail = opts.explainFailure?.()
        useLocal(inProcessWhy(detail ? `The host did not start: ${detail}` : 'The host did not start in time.'))
        return
      }
      await sleep(RETRY_MS)
    }
  }

  const ensure = (): Promise<void> => {
    if (mode === 'background' || mode === 'in-process' || mode === 'other-version') return Promise.resolve()
    connecting ??= establish()
      .catch((e: unknown) => useLocal(inProcessWhy(String(e))))
      .finally(() => {
        connecting = null
      })
    return connecting
  }

  const connectionLost = async (): Promise<void> => {
    if (leaving) return
    for (let i = 0; i < RECONNECT_TRIES; i++) {
      await sleep(RECONNECT_GAP_MS)
      const result = await connectToHost({ pipe: opts.pipe, secret: opts.secret, protocol })
      if (result.kind === 'ok') {
        wire(result.connection)
        try {
          const list = (await result.connection.request('list')) as HostedSession[]
          await Promise.all(
            list.filter((s) => mirrors.has(s.id)).map((session) => {
              // A view can't tell what it missed, so it gets the whole buffer again from a clean slate.
              return attach(result.connection, session, true)
            })
          )
          const known = new Set(list.map((s) => s.id))
          for (const [id, mirror] of mirrors) if (!known.has(id)) markExited(id, mirror, -1)
          changed()
          return
        } catch {
          return // The connection dropped again, so its close handler has taken over.
        }
      }
      if (result.kind === 'other-protocol') result.connection.close()
      if (result.kind === 'absent') break
    }
    welcome = null
    const hadSessions = [...mirrors.values()].some((m) => m.running)
    setMode('stopped', hadSessions ? 'The background session host stopped unexpectedly.' : undefined)
    for (const [id, mirror] of mirrors) markExited(id, mirror, -1)
    if (hadSessions) for (const cb of lostListeners) cb()
  }

  return {
    connect() {
      return ensure().then(info)
    },

    info,
    onInfo(cb) {
      infoListeners.push(cb)
    },
    onLost(cb) {
      lostListeners.push(cb)
    },

    sessions() {
      return [...mirrors].map(([id, m]) => ({ id, pid: m.pid, running: m.running, exitCode: m.exitCode, exitedAt: m.exitedAt }))
    },

    forget(id) {
      local?.forget(id)
      if (mirrors.get(id)?.running) return
      mirrors.delete(id)
      connection?.request('forget', { id }).catch(() => {})
    },

    repaintOnNextResize(id) {
      const mirror = mirrors.get(id)
      if (mirror) mirror.repaint = true
    },

    async start(spec: SessionSpec): Promise<void> {
      const id = spec.nodeId
      if (mode === 'other-version') {
        throw new SessionStartError('spawn-failed', 'Sessions can\'t start until you decide what to do with the older session host. Look in Settings under Background sessions.')
      }
      if (mirrors.get(id)?.running) throw new SessionStartError('spawn-failed', `Session ${id} is already running.`)
      const previous = mirrors.get(id)
      // Counted as running from here on, so nothing can start the same session twice while this is under way.
      const mirror: Mirror = {
        running: true,
        pid: null,
        buffer: createSessionBuffer(bufferBytes, spec.initialScrollback ?? ''),
        exitCode: null,
        exitedAt: null,
        queue: null,
        repaint: false,
        adopted: false,
        size: sizes.get(id)
      }
      mirrors.set(id, mirror)
      const undo = (): void => {
        if (previous) mirrors.set(id, previous)
        else mirrors.delete(id)
      }
      try {
        await ensure()
      } catch (e) {
        undo()
        throw e
      }
      if (mode === 'in-process' && local) {
        undo()
        const size = sizes.get(id)
        if (size) local.resize(id, size.cols, size.rows)
        local.start(spec)
        changed()
        return
      }
      const conn = connection
      if (!conn) {
        undo()
        throw new SessionStartError('spawn-failed', problem ?? 'The session host is not available.')
      }
      try {
        const { pid } = (await conn.request('start', { spec, size: sizes.get(id) })) as { pid: number | null }
        // A very short-lived program may already have reported its exit.
        if (mirror.running) mirror.pid = pid
        changed()
      } catch (e) {
        undo()
        const reason = e instanceof HostRequestError ? e.reason : undefined
        throw new SessionStartError(reason ?? 'spawn-failed', (e as Error).message)
      }
    },

    write(id, data) {
      if (local?.isRunning(id)) return local.write(id, data)
      if (mirrors.get(id)?.running) connection?.send({ t: 'w', id, d: data })
    },

    resize(id, cols, rows) {
      if (cols < 1 || rows < 1) return
      const c = Math.floor(cols)
      const r = Math.floor(rows)
      sizes.set(id, { cols: c, rows: r })
      if (local?.isRunning(id)) return local.resize(id, c, r)
      const mirror = mirrors.get(id)
      if (!mirror?.running || !connection) return
      const conn = connection
      // A plain shell stays out of this. Its screen is already right, and a redraw would repeat what's in its history.
      const nudge = mirror.adopted && (mirror.repaint || mirror.buffer.altScreen()) && c > 2
      mirror.adopted = false
      mirror.repaint = false
      // Windows redraws the whole screen on any resize, even to the same size, which would put those lines in the
      // stream a second time. A new view reporting the size it's always had mustn't cause that.
      const same = mirror.size?.cols === c && mirror.size?.rows === r
      mirror.size = { cols: c, rows: r }
      if (same && !nudge) return
      if (nudge) {
        conn.send({ t: 'r', id, cols: c - 1, rows: r })
        setTimeout(() => {
          const size = sizes.get(id) ?? { cols: c, rows: r }
          conn.send({ t: 'r', id, cols: size.cols, rows: size.rows })
        }, NUDGE_MS)
      } else {
        conn.send({ t: 'r', id, cols: c, rows: r })
      }
    },

    async kill(id) {
      if (local?.isRunning(id)) return local.kill(id)
      const mirror = mirrors.get(id)
      if (!mirror?.running) return
      try {
        await connection?.request('kill', { id })
      } catch {
        // If the host has gone, so has the session, and losing the connection reports that.
      }
    },

    pid(id) {
      if (local?.isRunning(id)) return local.pid(id)
      return mirrors.get(id)?.pid ?? null
    },

    isRunning(id) {
      return (local?.isRunning(id) ?? false) || (mirrors.get(id)?.running ?? false)
    },

    snapshot(id) {
      if (local?.list().some((s) => s.id === id)) {
        // Taken first, because taking it can deliver output and so move the count.
        const { data } = local.snapshot(id)
        return { data, seq: seqs.get(id) ?? 0 }
      }
      return { data: mirrors.get(id)?.buffer.read() ?? '', seq: seqs.get(id) ?? 0 }
    },

    onOutput(cb) {
      outputListeners.push(cb)
    },

    onExit(cb) {
      exitListeners.push(cb)
    },

    async detach() {
      leaving = true
      const conn = connection
      connection = null
      if (!conn) return
      const closed = new Promise<void>((resolve) => conn.onClose(resolve))
      conn.close()
      await Promise.race([closed, sleep(DETACH_WAIT_MS)])
    },

    async stopHost() {
      if (local) await Promise.all(local.list().filter((s) => s.running).map((s) => local?.kill(s.id)))
      const conn = connection
      if (conn) {
        const closed = new Promise<void>((resolve) => conn.onClose(resolve))
        // Set first: its going away is now expected, so there's nothing to reconnect to.
        connection = null
        // Exits still report as they arrive, because the connection's listeners stay on until it closes.
        await conn.request('stop-host').catch(() => {})
        await Promise.race([closed, sleep(STOP_WAIT_MS)])
        conn.close()
      }
      for (const [id, mirror] of mirrors) markExited(id, mirror, -1)
      welcome = null
      if (mode !== 'in-process') setMode('stopped')
    }
  }
}
