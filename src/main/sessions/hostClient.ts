import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { createFrameReader, encodeFrame, MAX_FRAME_BYTES, proofFor, proofMatches, type HostMessage, type HostOp, type HostRequestArgs } from './hostProtocol'

const HANDSHAKE_MS = 3000
/** Past any wait the host itself has, so this only fires if the host has really stopped answering. */
const REQUEST_MS = 20000

export interface HostWelcome {
  protocol: number
  version: string
  pid: number
  startedAt: number
  running: number
}

export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly reason?: 'cwd-missing' | 'spawn-failed'
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

export interface HostConnection {
  welcome: HostWelcome
  request(op: HostOp, args?: HostRequestArgs): Promise<unknown>
  /** Fire and forget: keystrokes and resizes. */
  send(message: HostMessage): void
  /** Called in stream order, in the same tick as the frame. */
  onMessage(cb: (message: HostMessage) => void): void
  /** Fires once. Everything still waiting has already failed. */
  onClose(cb: () => void): void
  close(): void
}

export type ConnectResult =
  /** Nothing is listening on this profile's pipe. */
  | { kind: 'absent' }
  /** Something is listening but didn't complete the handshake in time. */
  | { kind: 'unresponsive' }
  /** It failed the handshake, so it doesn't hold this profile's secret. */
  | { kind: 'refused' }
  | { kind: 'ok'; connection: HostConnection }
  /** A host speaking another protocol. Only `stop-host` will work on this connection. */
  | { kind: 'other-protocol'; connection: HostConnection }

function wrap(socket: Socket, welcome: HostWelcome, reader: { takeOver(cb: (m: HostMessage) => void): void }): HostConnection {
  let nextId = 1
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>()
  const messageListeners: Array<(m: HostMessage) => void> = []
  const closeListeners: Array<() => void> = []

  reader.takeOver((message) => {
    if (message.t === 'res') {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.ok) waiting.resolve(message.result)
      else waiting.reject(new HostRequestError(message.message, message.reason))
      return
    }
    for (const cb of messageListeners) cb(message)
  })

  socket.on('error', () => socket.destroy())
  socket.on('close', () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new HostRequestError('The session host went away.'))
    }
    pending.clear()
    for (const cb of closeListeners) cb()
  })

  return {
    welcome,
    request(op, args) {
      return new Promise((resolve, reject) => {
        if (socket.destroyed) return reject(new HostRequestError('The session host went away.'))
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new HostRequestError('The session host did not answer in time.'))
        }, REQUEST_MS)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        socket.write(encodeFrame({ t: 'req', id, op, args }))
      })
    },
    send(message) {
      if (!socket.destroyed) socket.write(encodeFrame(message))
    },
    onMessage(cb) {
      messageListeners.push(cb)
    },
    onClose(cb) {
      closeListeners.push(cb)
    },
    close() {
      socket.destroy()
    }
  }
}

/** One attempt, which never rejects. Both sides prove they hold the secret, and it never crosses the pipe. */
export function connectToHost(opts: { pipe: string; secret: string; protocol: number }): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const socket = connect(opts.pipe)
    const nonce = randomBytes(32).toString('hex')
    let settled = false
    let handler: (m: HostMessage) => void = () => {}

    const settle = (result: ConnectResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result.kind !== 'ok' && result.kind !== 'other-protocol') socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => settle({ kind: 'unresponsive' }), HANDSHAKE_MS)

    const reader = createFrameReader({
      limit: MAX_FRAME_BYTES,
      onFrame: (m) => handler(m),
      onError: () => {
        socket.destroy()
        settle({ kind: 'refused' })
      }
    })
    socket.on('data', (chunk: Buffer) => reader.push(chunk))
    socket.on('error', (e: NodeJS.ErrnoException) => {
      // A pipe with every instance busy is a host that's there and occupied, so try again as if it's starting.
      settle({ kind: e.code === 'ENOENT' ? 'absent' : 'unresponsive' })
    })
    socket.on('close', () => settle({ kind: 'refused' }))

    handler = (message) => {
      if (message.t === 'challenge') {
        socket.write(encodeFrame({ t: 'hello', proof: proofFor(opts.secret, 'app', message.nonce), nonce, protocol: opts.protocol }))
        return
      }
      if (message.t !== 'welcome' || !proofMatches(message.proof, proofFor(opts.secret, 'host', nonce))) {
        settle({ kind: 'refused' })
        return
      }
      const { protocol, version, pid, startedAt, running } = message
      const connection = wrap(socket, { protocol, version, pid, startedAt, running }, { takeOver: (cb) => void (handler = cb) })
      settle(protocol === opts.protocol ? { kind: 'ok', connection } : { kind: 'other-protocol', connection })
    }
  })
}
