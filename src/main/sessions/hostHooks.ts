import { timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { claudeOutput, journalLine, pickHookFields } from './hookPayload'

/**
 * Claude Code's hook events, served by the session host over http, so an event starts no process at all. Before, each
 * one started Node (and, before exec form, Git Bash too) to run resources/hook.cjs. See docs/plans/host-hooks.md.
 *
 * The host holds every session's terminal, so it runs exactly as long as the sessions whose hooks come here: the port
 * written into a session's settings stays good for that session's whole life, which an app's port never could.
 *
 * - With an app connected, each event goes to it over the host's pipe, and the app's answer goes back to Claude. A
 *   held permission request waits for the person, up to Claude's own limit. Anything else gets an answer within
 *   REPLY_LIMIT_MS even if the app is slow, and the app still gets the event, in order.
 * - With no app, Claude gets "nothing to say" at once: a permission request is then left to Claude's own prompt. The
 *   event is kept here until an app that takes hooks connects, which gets it in order, after what its journal holds.
 *   Only when the host stops, too many are waiting, or an app from before this is connected (it never takes them) do
 *   they go in the journal (missed/<node>.jsonl, as hook.cjs writes it), which an app reads when it takes a session on.
 *
 * Claude shows every answer that isn't a 2xx as a hook error, so anything that reaches a hook's path gets a 200, even a
 * request that fails its check: that one is just dropped. Nothing here waits on anything but the network, so a
 * session's terminal output is never held up by its hooks.
 */

/** Bigger bodies, such as a tool's whole output on PostToolUse, aren't parsed: the event's name is in the path. */
export const MAX_PARSED_BYTES = 1024 * 1024
/** Rolled over past this, as hook.cjs does. Only the latest events decide a status. */
const MAX_JOURNAL_BYTES = 256 * 1024
/** hook.cjs's own limit once it runs. Claude gets "nothing to say" by then; the app still gets the event. */
export const REPLY_LIMIT_MS = 1500
/** Past this many waiting for an app, they go in the journal. A few hundred bytes each. */
const MAX_HELD = 5000
const EVENT_NAME = /^[A-Za-z]{1,64}$/
/** Refused nodes said once each in the log, up to this many. */
const MAX_REFUSALS_LOGGED = 100

export interface HookForwarder {
  /**
   * `live` is false for an event nobody is waiting on any more: one kept while no app was connected, or one the app
   * before this didn't answer. An event keeps its `hid` when it's sent again, so an app can tell it already had it.
   */
  forward(hid: number, nodeId: string, payload: Record<string, unknown>, live: boolean): void
  /** Claude stopped waiting for this one, as when the person answered in the terminal. */
  cancel(hid: number): void
}

export interface HostHooksOptions {
  journalDir: string
  log?(message: string): void
  replyLimitMs?: number
  maxHeld?: number
}

export interface HostHooks {
  port: number
  /** A session's own PATCHBAY_TOKEN, which its hooks send back. */
  allow(nodeId: string, token: string): void
  disallow(nodeId: string): void
  /** An app that takes hooks connected. What was kept for it goes to it now, oldest first. */
  connect(forwarder: HookForwarder): void
  /** That app went away. What it hadn't answered is kept, and a held request gets "no decision". */
  disconnect(forwarder: HookForwarder): void
  /** An app from before hooks were served is connected, or not any more. While one is, events go to the journal. */
  appWithoutHooks(connected: boolean): void
  answer(hid: number, body: unknown): void
  /** Writes what's kept to the journal now. For stopping. */
  flush(): Promise<void>
  close(): Promise<void>
}

interface Kept {
  hid: number
  nodeId: string
  fields: Record<string, unknown>
  at: number
}

interface Pending extends Kept {
  event: string
  /** Set while Claude is still waiting for this answer. */
  respond: ((body: Record<string, unknown>) => void) | null
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The body as text, or null past the limit. The excess is drained, not stored. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_PARSED_BYTES) chunks.push(chunk)
    })
    req.on('end', () => resolve(size > MAX_PARSED_BYTES ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** Turned away without reading what it sent, and the connection closed. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { connection: 'close', 'content-length': 0 })
  res.end(() => req.destroy())
}

/** A request kept while no app was there is no longer waited on, so it comes back as what it showed: a prompt. */
function asNews(fields: Record<string, unknown>): Record<string, unknown> {
  if (fields.hook_event_name !== 'PermissionRequest') return fields
  const { tool_name: _n, tool_input: _i, ...rest } = fields
  return { ...rest, hook_event_name: 'Notification', notification_type: 'permission_prompt' }
}

export function startHostHooks(opts: HostHooksOptions): Promise<HostHooks> {
  const replyLimit = opts.replyLimitMs ?? REPLY_LIMIT_MS
  const maxHeld = opts.maxHeld ?? MAX_HELD
  const tokens = new Map<string, string>()
  const pending = new Map<number, Pending>()
  const refusedLogged = new Set<string>()
  let held: Kept[] = []
  let forwarder: HookForwarder | null = null
  let appsWithoutHooks = 0
  let nextHid = 1
  let port = 0
  let writing: Promise<void> = Promise.resolve()

  const writeJournal = (events: Kept[]): Promise<void> => {
    if (events.length === 0) return writing
    const byNode = new Map<string, string[]>()
    for (const e of events) byNode.set(e.nodeId, [...(byNode.get(e.nodeId) ?? []), journalLine(e.fields, e.at)])
    // One after another, so lines for a node stay in the order they happened.
    writing = writing.then(async () => {
      try {
        await mkdir(opts.journalDir, { recursive: true })
        for (const [nodeId, lines] of byNode) {
          const target = join(opts.journalDir, `${encodeURIComponent(nodeId)}.jsonl`)
          const size = await stat(target).then((s) => s.size, () => 0)
          if (size > MAX_JOURNAL_BYTES) await rename(target, `${target}.old`).catch(() => {})
          await appendFile(target, lines.join(''))
        }
      } catch (e) {
        opts.log?.(`Could not journal hook events: ${String(e)}`)
      }
    })
    return writing
  }

  const flushHeld = (): Promise<void> => {
    const events = held
    held = []
    return writeJournal(events)
  }

  const keep = (events: Kept[]): void => {
    held.push(...events)
    // An app from before this would never take them, and only reads the journal.
    if (held.length > maxHeld || appsWithoutHooks > 0) void flushHeld()
  }

  const forward = (e: Kept, event: string, respond: Pending['respond']): void => {
    pending.set(e.hid, { ...e, event, respond })
    forwarder?.forward(e.hid, e.nodeId, respond ? e.fields : asNews(e.fields), !!respond)
  }

  const noteRefused = (nodeId: string): void => {
    if (refusedLogged.has(nodeId) || refusedLogged.size >= MAX_REFUSALS_LOGGED) return
    refusedLogged.add(nodeId)
    opts.log?.(`Dropped a hook for ${JSON.stringify(nodeId.slice(0, 80))}: its node or token didn't match a session here.`)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Claude sends no Origin, and names the address in its settings. A web page sends an Origin, and a page reached by
    // rebinding its own name to 127.0.0.1 names its own host.
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return refuse(req, res, 403)
    // Event names are plain letters, so nothing in the path needs decoding.
    const event = req.method === 'POST' && req.url?.startsWith('/hook/') ? req.url.slice('/hook/'.length) : ''
    if (!EVENT_NAME.test(event)) return refuse(req, res, 404)
    const nodeId = req.headers['x-patchbay-node']
    const auth = req.headers.authorization
    const expected = typeof nodeId === 'string' ? tokens.get(nodeId) : undefined
    const text = await readBody(req)
    if (typeof nodeId !== 'string' || !expected || !auth?.startsWith('Bearer ') || !sameToken(auth.slice('Bearer '.length), expected)) {
      // Dropped, but answered as a success: anything else is a hook error in Claude, on every event.
      noteRefused(typeof nodeId === 'string' ? nodeId : '(none)')
      return send(res, 200, {})
    }
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = text === null ? {} : JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      // Only the event's name then, from the path.
    }
    const kept: Kept = { hid: nextHid++, nodeId, fields: pickHookFields(body, event), at: Date.now() }
    if (!forwarder) {
      keep([kept])
      return send(res, 200, {})
    }
    const forPerson = kept.fields.hook_event_name === 'PermissionRequest'
    let timer: NodeJS.Timeout | null = null
    const respond = (answer: Record<string, unknown>): void => {
      if (timer) clearTimeout(timer)
      send(res, 200, answer)
    }
    forward(kept, event, respond)
    if (!forPerson) {
      // A slow app still gets the event, in order. Claude just doesn't wait for it.
      timer = setTimeout(() => {
        const p = pending.get(kept.hid)
        if (p) p.respond = null
        send(res, 200, {})
      }, replyLimit)
    }
    res.on('close', () => {
      if (timer) clearTimeout(timer)
      const p = pending.get(kept.hid)
      if (!p?.respond) return
      p.respond = null
      // Claude gave up on it, as when the person answered in the terminal: the app's prompt for it goes too.
      if (forPerson) forwarder?.cancel(kept.hid)
    })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      opts.log?.(`A hook failed: ${String(e)}`)
      send(res, 200, {})
    })
  })
  // A held permission request is answered when the person answers, which can take minutes.
  server.requestTimeout = 0
  server.headersTimeout = 10_000

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', (e) => opts.log?.(`Hook server error: ${e.message}`))
      port = (server.address() as AddressInfo).port
      const api: HostHooks = {
        port,
        allow: (nodeId, token) => void tokens.set(nodeId, token),
        disallow: (nodeId) => void tokens.delete(nodeId),
        connect(next) {
          // A newer connection replaces an older one, and what the older hadn't answered goes to the newer.
          if (forwarder && forwarder !== next) api.disconnect(forwarder)
          forwarder = next
          const events = held
          held = []
          for (const e of events) forward(e, String(e.fields.hook_event_name), null)
        },
        disconnect(gone) {
          if (forwarder !== gone) return
          forwarder = null
          const unanswered = [...pending.values()].sort((a, b) => a.hid - b.hid)
          pending.clear()
          // A held request is left to Claude's own prompt, as hook.cjs leaves it when the app closes.
          for (const p of unanswered) p.respond?.({})
          keep(unanswered.map(({ hid, nodeId, fields, at }) => ({ hid, nodeId, fields, at })))
        },
        appWithoutHooks(connected) {
          appsWithoutHooks = Math.max(0, appsWithoutHooks + (connected ? 1 : -1))
          if (connected) void flushHeld()
        },
        answer(hid, answer) {
          const p = pending.get(hid)
          if (!p) return
          pending.delete(hid)
          p.respond?.(claudeOutput(p.event, answer))
        },
        flush: flushHeld,
        close: () =>
          new Promise((done) => {
            for (const p of pending.values()) p.respond?.({})
            server.close(() => done())
            server.closeAllConnections()
          })
      }
      resolve(api)
    })
  })
}
