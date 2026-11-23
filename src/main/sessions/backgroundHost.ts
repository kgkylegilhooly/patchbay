import type { HostInfo, SessionHost, SessionSpec } from '../../shared/contract'
import { isAlreadyRunning, SessionAlreadyRunning, SessionStartError, type PtyHost } from './host'
import { connectToHost, HostRequestError, type ConnectResult, type HostConnection, type HostWelcome } from './hostClient'
import { HOST_PROTOCOL, type HostedSession, type HostMessage } from './hostProtocol'
import { createHookRelay, type HookHandler } from './hookRelay'
import { createSessionBuffer, type SessionBuffer } from './sessionBuffer'

const DEFAULT_BUFFER_BYTES = 1024 * 1024
/** Long enough for a slow disk to load the host for the first time after a reboot. */
const START_TIMEOUT_MS = 15000
const RETRY_MS = 100
/** A dropped connection to a host that's still there comes back at once. */
const RECONNECT_TRIES = 3
const RECONNECT_GAP_MS = 300
/**
 * A host whose pipe is still there but that doesn't answer, as under memory pressure, hasn't gone: it's given this long
 * before its sessions are counted as ended. See docs/plans/session-sync.md.
 */
const UNRESPONSIVE_PATIENCE_MS = 30000
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
  /** A start is under way, so the host may not have it yet. */
  starting?: boolean
  /** While it was starting, a reconnect found the host already running it. */
  foundRunning?: boolean
  /** When it was made, as a count, so a check of the host's list can pass over mirrors newer than that list. */
  gen: number
}

export interface BackgroundHost extends SessionHost {
  start(spec: SessionSpec): Promise<void>
  /**
   * Reaches this profile's host, starting one if needed. Falls back to running sessions in the app. Never rejects.
   * With `quick`, resolves as soon as it's clear no host was running, while a new one starts: nothing can be running in
   * it yet, so there's nothing to wait for before showing the window. Starting one can mean copying the program first.
   */
  connect(opts?: { quick?: boolean }): Promise<HostInfo>
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
  /**
   * A session this app had counted as ended, or never heard of, turned out to be running in the host, as after a
   * reconnect to a host it had given up on. Its mirror is live again and its views have been sent its whole buffer.
   */
  onRevive(cb: (id: string) => void): void
  /** Asks the host what it runs and puts the mirrors right. Null when there's no host to ask. */
  refresh(): Promise<HostedSession[] | null>
  /**
   * Where the connected host serves sessions' hooks over http, or null to keep command hooks: no host, an older one, or
   * sessions running in the app. See docs/plans/host-hooks.md.
   */
  hookPort(): number | null
  /** Starts handling the hook events the host hands on. Those that came first have waited, in order. */
  serveHooks(handler: HookHandler): void
  /** The sessions some window shows, or null if none has said. The host sends the rest in bigger, rarer pieces. */
  setShown(ids: ReadonlySet<string> | null): void
}

export interface BackgroundHostOptions {
  pipe: string
  secret: string
  /** Throws if it can't even try. */
  spawnHost(): void | Promise<void>
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
  const reviveListeners: Array<(id: string) => void> = []
  /** Connected once already, so what a later connection finds running is a session coming back, not one to adopt. */
  let booted = false
  /** The sessions windows show, or null when no window has said. See setShown. */
  let shown: ReadonlySet<string> | null = null
  /** What the host was last told no window shows, so it's told only of a change. */
  let toldQuiet = ''
  let generation = 0

  let connection: HostConnection | null = null
  let local: PtyHost | null = null
  let welcome: HostWelcome | null = null
  let mode: HostInfo['mode'] = 'stopped'
  let problem: string | undefined
  let leaving = false
  let connecting: Promise<void> | null = null
  /** Waiting to hear that no host was running and one is being started. See connect's `quick`. */
  let spawning: Array<() => void> = []
  const hooks = createHookRelay()
  const connectOpts = { pipe: opts.pipe, secret: opts.secret, protocol, hooks: true }

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
    const known = mirrors.get(session.id)
    // Running in the host, though this app had counted it as ended or never heard of it. See docs/plans/session-sync.md.
    const revived = booted && session.running && !known?.running
    if (known?.starting && session.running) known.foundRunning = true
    const mirror: Mirror = known ?? {
      running: session.running,
      pid: session.pid,
      buffer: createSessionBuffer(bufferBytes),
      exitCode: session.exitCode,
      exitedAt: session.exitedAt,
      queue: null,
      repaint: false,
      adopted: session.running,
      size: session.size,
      gen: ++generation
    }
    mirrors.set(session.id, mirror)
    mirror.queue = []
    const { data } = (await conn.request('attach', { id: session.id })) as { data: string }
    mirror.buffer = createSessionBuffer(bufferBytes, data)
    mirror.pid = session.pid
    if (revived) {
      mirror.running = true
      mirror.exitCode = null
      mirror.exitedAt = null
      // Its program may need telling to redraw, as one adopted at launch does.
      mirror.adopted = true
      mirror.size = session.size ?? mirror.size
    }
    // A view of a revived session missed what it printed meanwhile, so it gets the whole buffer from a clean slate.
    if (reset || revived) emitOutput(session.id, `${FULL_RESET}${data}`)
    const queued = mirror.queue
    mirror.queue = null
    for (const apply of queued) apply()
    // The host's record is the truth, for one that ended while nobody was connected.
    if (!session.running && mirror.running && !mirror.starting) markExited(session.id, mirror, session.exitCode ?? -1, session.exitedAt ?? undefined)
    if (revived && mirror.running) {
      for (const cb of reviveListeners) cb(session.id)
      changed()
    }
  }

  /** Tells the host, or the sessions in the app, which sessions no window shows. Only those this app knows. */
  const tellQuiet = (force = false): void => {
    const ids = shown ? [...mirrors.keys(), ...(local?.list().map((s) => s.id) ?? [])].filter((id) => !shown?.has(id)).sort() : []
    const key = JSON.stringify(ids)
    if (key === toldQuiet && !force) return
    toldQuiet = key
    local?.setQuiet?.(ids)
    if (mode === 'background') connection?.send({ t: 'quiet', ids })
  }

  const wire = (conn: HostConnection): void => {
    connection = conn
    welcome = conn.welcome
    hooks.forHost(`${conn.welcome.pid}:${conn.welcome.startedAt}`)
    conn.onMessage((message) => {
      if (!hooks.receive(conn, message)) handleMessage(message)
    })
    conn.onClose(() => {
      hooks.dropConnection(conn)
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
    let deadline = Date.now() + startTimeout
    let spawned = false
    for (;;) {
      const result: ConnectResult = await connectToHost(connectOpts)
      if (result.kind === 'ok') {
        wire(result.connection)
        const list = (await result.connection.request('list')) as HostedSession[]
        await Promise.all(list.map((session) => attach(result.connection, session, false)))
        booted = true
        setMode('background')
        tellQuiet(true)
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
        for (const cb of spawning.splice(0)) cb()
        try {
          await opts.spawnHost()
          // Starting it can mean copying the program first, on a slow disk for a while: the wait counts from now.
          deadline = Date.now() + startTimeout
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

  /** A reconnect under way, which attaches every session: a refresh waits for it rather than attach them over it. */
  let reconnecting: Promise<void> | null = null
  const connectionLost = (): Promise<void> => {
    reconnecting = reconnect().finally(() => {
      reconnecting = null
    })
    return reconnecting
  }

  const reconnect = async (): Promise<void> => {
    if (leaving) return
    const patience = Date.now() + UNRESPONSIVE_PATIENCE_MS
    for (let i = 0; i < RECONNECT_TRIES || Date.now() < patience; i++) {
      await sleep(RECONNECT_GAP_MS)
      const result = await connectToHost(connectOpts)
      if (result.kind === 'ok') {
        wire(result.connection)
        try {
          const list = (await result.connection.request('list')) as HostedSession[]
          await Promise.all(
            // One this app never heard of is included if it runs: a start whose reply was lost with the connection.
            list.filter((s) => mirrors.has(s.id) || s.running).map((session) => {
              // A view can't tell what it missed, so it gets the whole buffer again from a clean slate.
              return attach(result.connection, session, true)
            })
          )
          const known = new Set(list.map((s) => s.id))
          for (const [id, mirror] of mirrors) if (!known.has(id) && !mirror.starting) markExited(id, mirror, -1)
          changed()
          // A new connection starts with every session shown.
          tellQuiet(true)
          return
        } catch {
          return // The connection dropped again, so its close handler has taken over.
        }
      }
      if (result.kind === 'other-protocol') result.connection.close()
      if (result.kind === 'absent') break
      // Only a host that's there but not answering earns the longer wait.
      if (result.kind !== 'unresponsive' && i >= RECONNECT_TRIES - 1) break
    }
    welcome = null
    const hadSessions = [...mirrors.values()].some((m) => m.running)
    setMode('stopped', hadSessions ? 'The background session host stopped unexpectedly.' : undefined)
    for (const [id, mirror] of mirrors) markExited(id, mirror, -1)
    if (hadSessions) for (const cb of lostListeners) cb()
  }

  return {
    connect(o) {
      const done = ensure().then(info)
      if (!o?.quick) return done
      return new Promise<HostInfo>((resolve) => {
        const early = (): void => resolve(info())
        spawning.push(early)
        void done.then((i) => {
          spawning = spawning.filter((cb) => cb !== early)
          resolve(i)
        })
      })
    },

    info,
    onInfo(cb) {
      infoListeners.push(cb)
    },
    onLost(cb) {
      lostListeners.push(cb)
    },
    onRevive(cb) {
      reviveListeners.push(cb)
    },

    async refresh() {
      if (reconnecting) await reconnecting
      const conn = connection
      if (mode !== 'background' || !conn) return null
      const asked = generation
      let list: HostedSession[]
      try {
        list = (await conn.request('list')) as HostedSession[]
      } catch {
        return null // Gone again: losing the connection deals with it.
      }
      if (connection !== conn) return null
      const byId = new Map(list.map((s) => [s.id, s]))
      for (const session of list) {
        if (session.running && !mirrors.get(session.id)?.running) await attach(conn, session, false).catch(() => {})
      }
      // Only mirrors older than the list can be judged by it, and never one still starting.
      for (const [id, mirror] of mirrors) {
        if (!mirror.running || mirror.starting || mirror.gen > asked) continue
        const there = byId.get(id)
        if (!there) markExited(id, mirror, -1)
        else if (!there.running) markExited(id, mirror, there.exitCode ?? -1, there.exitedAt ?? undefined)
      }
      return list
    },

    hookPort() {
      return mode === 'background' ? (connection?.welcome.hookPort ?? null) : null
    },

    serveHooks: (handler) => hooks.serve(handler),

    setShown(ids) {
      shown = ids
      tellQuiet()
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
      if (mirrors.get(id)?.running) throw new SessionAlreadyRunning(id)
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
        size: sizes.get(id),
        starting: true,
        gen: ++generation
      }
      mirrors.set(id, mirror)
      /** The host was running it all along, so this joins that session rather than start a second. */
      const joined = (): SessionAlreadyRunning => {
        mirror.starting = false
        mirror.foundRunning = false
        mirror.adopted = true
        changed()
        return new SessionAlreadyRunning(id)
      }
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
      // Reconnecting just now found it running. Its buffer is the host's, which views haven't seen.
      if (mirror.foundRunning) {
        emitOutput(id, `${FULL_RESET}${mirror.buffer.read()}`)
        throw joined()
      }
      // Its hooks were written for the host that was connected then, which this no longer is.
      if (spec.hookPort !== undefined && (mode !== 'background' || connection?.welcome.hookPort !== spec.hookPort)) {
        undo()
        throw new SessionStartError('spawn-failed', 'The session host changed while this was starting. Restart it to try again.')
      }
      if (mode === 'in-process' && local) {
        undo()
        const size = sizes.get(id)
        if (size) local.resize(id, size.cols, size.rows)
        local.start(spec)
        changed()
        tellQuiet()
        return
      }
      const conn = connection
      if (!conn) {
        undo()
        throw new SessionStartError('spawn-failed', problem ?? 'The session host is not available.')
      }
      try {
        const { pid } = (await conn.request('start', { spec, size: sizes.get(id) })) as { pid: number | null }
        mirror.starting = false
        // A very short-lived program may already have reported its exit.
        if (mirror.running) mirror.pid = pid
        changed()
        tellQuiet()
      } catch (e) {
        // The host already runs it, out of this app's sight: join it rather than leave it unreachable.
        if (isAlreadyRunning(e) && connection === conn) {
          const there = await conn.request('list').then((l) => (l as HostedSession[]).find((s) => s.id === id && s.running), () => undefined)
          if (there) {
            await attach(conn, there, true)
            if (mirror.running) throw joined()
          }
        }
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
