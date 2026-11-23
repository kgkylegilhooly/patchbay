import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import type { SessionSpec } from '../../shared/contract'
import { SessionStartError, type PtyHost } from './host'
import type { HookForwarder, HostHooks } from './hostHooks'
import {
  createFrameReader,
  encodeFrame,
  MAX_FRAME_BYTES,
  PRE_AUTH_FRAME_BYTES,
  proofFor,
  proofMatches,
  type HostMessage,
  type HostRequestArgs
} from './hostProtocol'

/** An app that doesn't prove itself this fast is dropped. */
const HANDSHAKE_MS = 5000
/** Output queued for the app past this makes the sessions producing it wait, so memory stays bounded. */
const HIGH_WATER_BYTES = 1024 * 1024
/**
 * A hung app must not be able to wedge its sessions. After this long without draining it's dropped, and its
 * sessions carry on into the buffer. A recovered app reconnects and gets the buffer in one piece.
 */
const STALL_MS = 10000

export interface HostServerOptions {
  pipe: string
  secret: string
  protocol: number
  version: string
  startedAt: number
  sessions: PtyHost
  /** The app connected or went away. */
  onConnectionChange?(connected: boolean): void
  onStopRequested(): void
  onSessionStarted?(spec: SessionSpec): void
  onSessionForgotten?(id: string): void
  log?(message: string): void
  /** Sessions' hook events, served over http and handed to an app that takes them. See hostHooks.ts. */
  hooks?: HostHooks
  highWaterBytes?: number
  stallMs?: number
}

export interface HostServer {
  connected(): boolean
  close(): Promise<void>
}

interface Client {
  socket: Socket
  /** Sessions whose output this client has joined. Output before then is in its attach reply. */
  attached: Set<string>
  /** It speaks another protocol, so all it can do is learn about this host and stop it. */
  limited: boolean
  /** Set when it takes sessions' hook events. */
  forwarder?: HookForwarder
  /** It doesn't, being from before they were served: hooks go to the journal it reads. */
  withoutHooks?: boolean
}

export function startHostServer(opts: HostServerOptions): Promise<HostServer> {
  const { sessions } = opts
  const highWater = opts.highWaterBytes ?? HIGH_WATER_BYTES
  const stallMs = opts.stallMs ?? STALL_MS
  let client: Client | null = null
  const paused = new Set<string>()
  let stall: NodeJS.Timeout | null = null

  const resumeAll = (): void => {
    if (stall) clearTimeout(stall)
    stall = null
    for (const id of paused) sessions.resume(id)
    paused.clear()
  }

  const send = (socket: Socket, message: HostMessage): void => {
    if (!socket.destroyed) socket.write(encodeFrame(message))
  }

  sessions.onOutput((id, data) => {
    if (!client?.attached.has(id)) return
    send(client.socket, { t: 'o', id, d: data })
    if (client.socket.writableLength <= highWater || paused.has(id)) return
    paused.add(id)
    sessions.pause(id)
    if (!stall) {
      const socket = client.socket
      stall = setTimeout(() => {
        opts.log?.('The app stopped reading output, so it was disconnected.')
        socket.destroy()
      }, stallMs)
    }
  })
  sessions.onExit((id, code) => {
    paused.delete(id)
    if (client?.attached.has(id)) send(client.socket, { t: 'x', id, code })
  })

  const serve = async (current: Client, op: string, args: HostRequestArgs): Promise<unknown> => {
    if (op === 'stop-host') {
      setImmediate(() => opts.onStopRequested())
      return undefined
    }
    if (current.limited) throw new Error(`This host speaks protocol ${opts.protocol}, so it can only be stopped.`)
    const id = args.id ?? ''
    switch (op) {
      case 'list':
        return sessions.list()
      case 'attach': {
        // Taken before joining: taking it delivers what's pending, which belongs in the reply rather than after it.
        current.attached.delete(id)
        const { data } = sessions.snapshot(id)
        current.attached.add(id)
        return { data }
      }
      case 'start': {
        if (!args.spec) throw new Error('start needs a spec.')
        if (args.size) sessions.resize(args.spec.nodeId, args.size.cols, args.size.rows)
        sessions.start(args.spec)
        // Its hooks prove themselves with the token its own environment has.
        const token = args.spec.env?.PATCHBAY_TOKEN
        if (token) opts.hooks?.allow(args.spec.nodeId, token)
        current.attached.add(args.spec.nodeId)
        opts.onSessionStarted?.(args.spec)
        return { pid: sessions.pid(args.spec.nodeId) }
      }
      case 'kill':
        return sessions.kill(id)
      case 'forget':
        current.attached.delete(id)
        opts.onSessionForgotten?.(id)
        if (!sessions.isRunning(id)) opts.hooks?.disallow(id)
        return sessions.forget(id)
      default:
        throw new Error(`Unknown request: ${op}`)
    }
  }

  const accept = (socket: Socket): void => {
    const nonce = randomBytes(32).toString('hex')
    let current: Client | null = null
    const handshake = setTimeout(() => socket.destroy(), HANDSHAKE_MS)

    const onFrame = (message: HostMessage): void => {
      if (!current) {
        if (message.t !== 'hello' || !proofMatches(message.proof, proofFor(opts.secret, 'app', nonce)) || typeof message.nonce !== 'string') {
          socket.destroy()
          return
        }
        clearTimeout(handshake)
        // Only one app can hold a profile's lock, so an older connection is a leftover.
        client?.socket.destroy()
        current = { socket, attached: new Set(), limited: message.protocol !== opts.protocol }
        client = current
        reader.setLimit(MAX_FRAME_BYTES)
        send(socket, {
          t: 'welcome',
          proof: proofFor(opts.secret, 'host', message.nonce),
          protocol: opts.protocol,
          version: opts.version,
          pid: process.pid,
          startedAt: opts.startedAt,
          running: sessions.list().filter((s) => s.running).length,
          ...(opts.hooks ? { hookPort: opts.hooks.port } : {})
        })
        opts.onConnectionChange?.(true)
        // Only an app that says it takes them gets hook events. Any other leaves them to the journal.
        if (opts.hooks && message.hooks === true && !current.limited) {
          current.forwarder = {
            forward: (hid, id, payload, live) => send(socket, { t: 'hook', hid, id, payload, live }),
            cancel: (hid) => send(socket, { t: 'hook-cancel', hid })
          }
          opts.hooks.connect(current.forwarder)
        } else if (opts.hooks) {
          current.withoutHooks = true
          opts.hooks.appWithoutHooks(true)
        }
        return
      }
      const me = current
      if (message.t === 'hook-res') {
        if (me.forwarder) opts.hooks?.answer(message.hid, message.body)
      } else if (message.t === 'w') {
        if (!me.limited) sessions.write(message.id, message.d)
      } else if (message.t === 'r') {
        if (!me.limited) sessions.resize(message.id, message.cols, message.rows)
      } else if (message.t === 'quiet') {
        if (!me.limited && Array.isArray(message.ids)) sessions.setQuiet?.(message.ids.filter((x): x is string => typeof x === 'string'))
      } else if (message.t === 'req') {
        const { id: requestId, op, args } = message
        serve(me, op, args ?? {}).then(
          (result) => send(socket, { t: 'res', id: requestId, ok: true, result }),
          (e: unknown) =>
            send(socket, {
              t: 'res',
              id: requestId,
              ok: false,
              ...(e instanceof SessionStartError ? { reason: e.reason } : {}),
              message: e instanceof Error ? e.message : String(e)
            })
        )
      }
    }

    const reader = createFrameReader({
      limit: PRE_AUTH_FRAME_BYTES,
      onFrame,
      onError: (reason) => {
        opts.log?.(`Dropped a connection: ${reason}`)
        socket.destroy()
      }
    })

    socket.on('data', (chunk: Buffer) => reader.push(chunk))
    socket.on('drain', () => {
      if (client?.socket === socket) resumeAll()
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(handshake)
      if (current?.forwarder) opts.hooks?.disconnect(current.forwarder)
      if (current?.withoutHooks) opts.hooks?.appWithoutHooks(false)
      if (client?.socket !== socket) return
      client = null
      resumeAll()
      // The next app says for itself what it shows.
      sessions.setQuiet?.([])
      opts.onConnectionChange?.(false)
    })
    send(socket, { t: 'challenge', nonce, protocol: opts.protocol })
  }

  const server: Server = createServer(accept)
  return new Promise((resolve, reject) => {
    // A second host for this profile fails here, because the first owns the pipe's name.
    server.once('error', reject)
    server.listen(opts.pipe, () => {
      server.off('error', reject)
      server.on('error', (e) => opts.log?.(`Pipe error: ${e.message}`))
      resolve({
        connected: () => client !== null,
        close: () =>
          new Promise((done) => {
            client?.socket.destroy()
            server.close(() => done())
          })
      })
    })
  })
}
