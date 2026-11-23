import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionSpec } from '../../shared/contract'

/**
 * Bump this whenever a message below changes meaning. A running host outlives an app update, so the two
 * can differ, and the app must then ask rather than assume.
 *
 * Frozen for every version, so any app can always identify and stop any older host:
 * the challenge, hello and welcome messages, and the `stop-host` request. Fields added to those since are optional,
 * and each side acts only on one the other has sent: hooks (docs/plans/host-hooks.md) are offered by the app's `hooks`
 * in hello and the host's `hookPort` in welcome, so a host or app from before them simply goes without.
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
  | { t: 'welcome'; proof: string; protocol: number; version: string; pid: number; startedAt: number; running: number; hookPort?: number }
  | { t: 'res'; id: number; ok: true; result?: unknown }
  | { t: 'res'; id: number; ok: false; reason?: 'cwd-missing' | 'spawn-failed'; message: string }
  | { t: 'o'; id: string; d: string }
  | { t: 'x'; id: string; code: number }
  /** A session's hook event, for the app to answer with hook-res. `live`: Claude is waiting for that answer. */
  | { t: 'hook'; hid: number; id: string; payload: Record<string, unknown>; live: boolean }
  /** Claude stopped waiting for that answer. */
  | { t: 'hook-cancel'; hid: number }
  // App to host.
  | { t: 'hello'; proof: string; nonce: string; protocol: number; hooks?: boolean }
  | { t: 'hook-res'; hid: number; body?: unknown }
  | { t: 'req'; id: number; op: HostOp; args?: HostRequestArgs }
  | { t: 'w'; id: string; d: string }
  | { t: 'r'; id: string; cols: number; rows: number }
  /**
   * The sessions no window shows, which send their output in bigger, rarer pieces. Replaces the last such list. A host
   * from before this ignores it, as any host ignores a message it doesn't know, so it changes no message's meaning.
   */
  | { t: 'quiet'; ids: string[] }

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

/**
 * Reassembles frames however the stream splits them. `onError` is final: the connection should be closed.
 * The pieces of a frame are kept as they came and joined once, when the frame is whole: joining each new piece onto
 * all before it copied a big frame over and over, 600 ms for twenty 1 MB frames in 4 KB pieces.
 */
export function createFrameReader(opts: { limit: number; onFrame: (message: HostMessage) => void; onError: (reason: string) => void }): FrameReader {
  let limit = opts.limit
  /** What has come and not been read yet, oldest first. The first piece may be partly read already. */
  let chunks: Buffer[] = []
  let buffered = 0
  /** The size the next frame says it has, once its header is in. */
  let need = -1
  let failed = false

  const fail = (reason: string): void => {
    failed = true
    chunks = []
    buffered = 0
    opts.onError(reason)
  }

  /** Takes the first `n` bytes waiting. A copy only when they span pieces. */
  const take = (n: number): Buffer => {
    const first = chunks[0]
    if (first.length >= n) {
      const out = first.subarray(0, n)
      if (first.length === n) chunks.shift()
      else chunks[0] = first.subarray(n)
      buffered -= n
      return out
    }
    const out = Buffer.allocUnsafe(n)
    let at = 0
    while (at < n) {
      const c = chunks[0]
      const used = Math.min(c.length, n - at)
      c.copy(out, at, 0, used)
      at += used
      if (used === c.length) chunks.shift()
      else chunks[0] = c.subarray(used)
    }
    buffered -= n
    return out
  }

  return {
    setLimit(bytes) {
      limit = bytes
    },
    push(chunk) {
      if (failed || !chunk.length) return
      chunks.push(chunk)
      buffered += chunk.length
      for (;;) {
        if (need < 0) {
          if (buffered < HEADER_BYTES) return
          need = take(HEADER_BYTES).readUInt32LE(0)
          if (need > limit) return fail(`A frame of ${need} bytes is over the limit of ${limit}.`)
        }
        if (buffered < need) return
        const body = take(need)
        need = -1
        let message: HostMessage
        try {
          message = JSON.parse(body.toString('utf8')) as HostMessage
        } catch {
          return fail('A frame was not valid JSON.')
        }
        opts.onFrame(message)
        if (failed) return
      }
    }
  }
}
