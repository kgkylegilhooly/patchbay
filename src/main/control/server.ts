import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { parseUsageReport, type UsageReport } from '../../shared/usage'

const MAX_BODY_BYTES = 1024 * 1024

/** Thrown by an RPC handler to refuse a request. Its message goes back to the caller. */
export class RpcRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcRefusal'
  }
}

export function tokenFor(secret: string, nodeId: string): string {
  return createHmac('sha256', secret).update(nodeId).digest('hex')
}

/** Tokens derive from this, so keeping it across launches keeps running sessions' tokens valid. */
export function loadOrCreateSecret(file: string): string {
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  mkdirSync(dirname(file), { recursive: true })
  const secret = randomBytes(32).toString('hex')
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

function writeEndpoint(file: string, port: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  // The pid lets a session tell a crashed app from a slow one, without waiting on a dead port.
  writeFileSync(tmp, JSON.stringify({ port, pid: process.pid }))
  renameSync(tmp, file)
}

function authorized(req: IncomingMessage, secret: string): string | null {
  const nodeId = req.headers['x-patchbay-node']
  const auth = req.headers.authorization
  if (typeof nodeId !== 'string' || !nodeId || !auth?.startsWith('Bearer ')) return null
  const given = Buffer.from(auth.slice('Bearer '.length))
  const expected = Buffer.from(tokenFor(secret, nodeId))
  return given.length === expected.length && timingSafeEqual(given, expected) ? nodeId : null
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Resolves to the body text, or null if it went over the limit. The excess is drained, not stored. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface ControlServerOptions {
  secret: string
  endpointFile: string
  /** The reply may wait. The signal aborts if the caller's connection closes before then. */
  onHook(nodeId: string, payload: Record<string, unknown>, signal: AbortSignal): unknown
  onRpc(callerNodeId: string, verb: string, args: Record<string, unknown>): Promise<unknown>
  onUsage?(nodeId: string, report: UsageReport): void
}

export interface ControlServer {
  port: number
  address(): AddressInfo
  close(): Promise<void>
}

export function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = req.method === 'POST' ? req.url : undefined
    if (route !== '/hook' && route !== '/rpc' && route !== '/usage') {
      req.resume()
      return reply(res, 404, { error: 'not found' })
    }
    const nodeId = authorized(req, opts.secret)
    if (!nodeId) {
      req.resume()
      return reply(res, 401, { error: 'unauthorized' })
    }
    const text = await readBody(req)
    if (text === null) return reply(res, 413, { error: 'request body too large' })
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return reply(res, 400, { error: 'body is not JSON' })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply(res, 400, { error: 'body must be a JSON object' })
    }
    const fields = body as Record<string, unknown>

    if (route === '/usage') {
      opts.onUsage?.(nodeId, parseUsageReport(fields))
      return reply(res, 200, {})
    }
    if (route === '/hook') {
      const connection = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) connection.abort()
      })
      return reply(res, 200, (await opts.onHook(nodeId, fields, connection.signal)) ?? {})
    }
    if (typeof fields.verb !== 'string') return reply(res, 400, { error: 'verb is required' })
    const args = fields.args ?? {}
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return reply(res, 400, { error: 'args must be a JSON object' })
    }
    reply(res, 200, { result: await opts.onRpc(nodeId, fields.verb, args as Record<string, unknown>) })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof RpcRefusal) reply(res, 400, { error: e.message })
      else reply(res, 500, { error: 'internal error' })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address() as AddressInfo
      try {
        writeEndpoint(opts.endpointFile, address.port)
      } catch (e) {
        server.close()
        return reject(e)
      }
      let closing: Promise<void> | null = null
      resolve({
        port: address.port,
        address: () => address,
        close() {
          closing ??= new Promise((done) => {
            // Sessions may outlive this app, and this tells them at once that nobody's there.
            try {
              rmSync(opts.endpointFile, { force: true })
            } catch (e) {
              console.error('Patchbay could not remove its endpoint file:', e)
            }
            server.close(() => done())
            server.closeAllConnections()
          })
          return closing
        }
      })
    })
  })
}
