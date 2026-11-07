import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionSpec } from '../../shared/contract'

/**
 * Bump this whenever a message below changes meaning. A running host outlives an app update, so the two
 * can differ, and the app must then ask rather than assume.
 *
 * Frozen for every version, so any app can always identify and stop any older host:
 * the challenge, hello and welcome messages, and the `stop-host` request.
 */
export const HOST_PROTOCOL = 1

/** Frames are a 4-byte little-endian length, then that much UTF-8 JSON. */
const HEADER_BYTES = 4
/** A session's buffer is at most 1 MiB, and JSON can escape control characters to six times their size. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024
/** Nothing unauthenticated gets to make the host hold more than this. */
export const PRE_AUTH_FRAME_BYTES = 64 * 1024

export type HostOp = 'list' | 'attach' | 'start' | 'kill' | 'forget' | 'stop-host'

export interface HostedSession {
  id: string
  pid: number | null
  running: boolean
  exitCode: number | null
  /** When it ended, or null while it runs. */
  exitedAt: number | null
  /** The size its program last got told, if any. */
  size?: { cols: number; rows: number }
}

export type HostMessage =
  // Host to app.
  | { t: 'challenge'; nonce: string; protocol: number }
  | { t: 'welcome'; proof: string; protocol: number; version: string; pid: number; startedAt: number; running: number }
  | { t: 'res'; id: number; ok: true; result?: unknown }
  | { t: 'res'; id: number; ok: false; reason?: 'cwd-missing' | 'spawn-failed'; message: string }
  | { t: 'o'; id: string; d: string }
  | { t: 'x'; id: string; code: number }
  // App to host.
  | { t: 'hello'; proof: string; nonce: string; protocol: number }
  | { t: 'req'; id: number; op: HostOp; args?: HostRequestArgs }
  | { t: 'w'; id: string; d: string }
  | { t: 'r'; id: string; cols: number; rows: number }

export interface HostRequestArgs {
  id?: string
  spec?: SessionSpec
  size?: { cols: number; rows: number }
}

/** The pipe for one user-data folder, so a test profile and the real one can never share a host. */
export function pipeNameFor(dataDir: string): string {
  const key = createHash('sha256').update(resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24)
  return `\\\\.\\pipe\\patchbay-host-${key}`
}

/** Proves knowledge of the secret without sending it, so a process squatting on the pipe learns nothing. */
export function proofFor(secret: string, role: 'app' | 'host', nonce: string): string {
  return createHmac('sha256', secret).update(`${role}:${nonce}`).digest('hex')
}

export function proofMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function encodeFrame(message: HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export interface FrameReader {
  push(chunk: Buffer): void
  setLimit(bytes: number): void
}

/** Reassembles frames however the stream splits them. `onError` is final: the connection should be closed. */
export function createFrameReader(opts: { limit: number; onFrame: (message: HostMessage) => void; onError: (reason: string) => void }): FrameReader {
  let limit = opts.limit
  let pending: Buffer = Buffer.alloc(0)
  let failed = false

  const fail = (reason: string): void => {
    failed = true
    pending = Buffer.alloc(0)
    opts.onError(reason)
  }

  return {
    setLimit(bytes) {
      limit = bytes
    },
    push(chunk) {
      if (failed) return
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let at = 0
      while (pending.length - at >= HEADER_BYTES) {
        const size = pending.readUInt32LE(at)
        if (size > limit) return fail(`A frame of ${size} bytes is over the limit of ${limit}.`)
        if (pending.length - at - HEADER_BYTES < size) break
        const body = pending.subarray(at + HEADER_BYTES, at + HEADER_BYTES + size)
        at += HEADER_BYTES + size
        let message: HostMessage
        try {
          message = JSON.parse(body.toString('utf8')) as HostMessage
        } catch {
          return fail('A frame was not valid JSON.')
        }
        opts.onFrame(message)
        if (failed) return
      }
      pending = at === pending.length ? Buffer.alloc(0) : pending.subarray(at)
    }
  }
}
