import type { HostMessage } from './hostProtocol'

/**
 * The app's end of hooks served by the session host (see hostHooks.ts): events come over the host's pipe, are handled
 * exactly as the control server's /hook handles them, and the answer goes back over the pipe.
 *
 * The app connects to its host before it can handle anything, so what arrives first waits here, in order, until the app
 * says it's ready (`serve`). It takes up what the journal held first, so nothing is applied out of order.
 *
 * One node's events are handled one after another, as Claude sends them. A held permission request only goes first:
 * the wait for the person mustn't hold up the Notification that follows it, or a request from a tool running alongside.
 */

export type HookHandler = (nodeId: string, payload: Record<string, unknown>, signal: AbortSignal) => unknown

export interface RelayConnection {
  send(message: HostMessage): void
}

export interface HookRelay {
  /** Takes the host's hook messages. False for any other message. */
  receive(conn: RelayConnection, message: HostMessage): boolean
  /** Handles what's waiting, then everything as it comes. */
  serve(handler: HookHandler): void
  /** That connection closed: the host keeps what it hadn't been answered, and sends it again over the next. */
  dropConnection(conn: RelayConnection): void
}

/** Far more than an app's start-up ever gathers. Past it, Claude is told "nothing to say" and the host's copy stands. */
const MAX_WAITING = 5000
/** How long a held request goes first before the next of its node's events is handled. */
const HELD_HEAD_START_MS = 50

interface Item {
  conn: RelayConnection
  hid: number
  id: string
  payload: Record<string, unknown>
}

export function createHookRelay(): HookRelay {
  let handler: HookHandler | null = null
  const waiting: Item[] = []
  const inFlight = new Map<number, { conn: RelayConnection; controller: AbortController }>()
  const chains = new Map<string, Promise<void>>()
  const closed = new WeakSet<RelayConnection>()

  const run = (item: Item, handle: HookHandler): void => {
    const controller = new AbortController()
    inFlight.set(item.hid, { conn: item.conn, controller })
    const previous = chains.get(item.id) ?? Promise.resolve()
    const handled = previous.then(async () => {
      if (closed.has(item.conn)) return
      let body: unknown = {}
      try {
        body = (await handle(item.id, item.payload, controller.signal)) ?? {}
      } catch {
        // Refused, as a hook from another node's session is: nothing to say.
      }
      inFlight.delete(item.hid)
      if (!closed.has(item.conn)) item.conn.send({ t: 'hook-res', hid: item.hid, body })
    })
    const next =
      item.payload.hook_event_name === 'PermissionRequest'
        ? Promise.race([handled, new Promise<void>((r) => setTimeout(r, HELD_HEAD_START_MS))])
        : handled
    const settled = next.catch(() => {})
    chains.set(item.id, settled)
    void settled.then(() => {
      if (chains.get(item.id) === settled) chains.delete(item.id)
    })
  }

  return {
    receive(conn, message) {
      if (message.t === 'hook-cancel') {
        inFlight.get(message.hid)?.controller.abort()
        return true
      }
      if (message.t !== 'hook') return false
      const item: Item = { conn, hid: message.hid, id: message.id, payload: message.payload ?? {} }
      if (handler) run(item, handler)
      else if (waiting.length < MAX_WAITING) waiting.push(item)
      else conn.send({ t: 'hook-res', hid: item.hid, body: {} })
      return true
    },
    serve(next) {
      handler = next
      for (const item of waiting.splice(0)) if (!closed.has(item.conn)) run(item, next)
    },
    dropConnection(conn) {
      closed.add(conn)
      for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].conn === conn) waiting.splice(i, 1)
      // Held requests are left to Claude's own prompt now, so their prompts here go.
      for (const [hid, f] of inFlight) {
        if (f.conn !== conn) continue
        f.controller.abort()
        inFlight.delete(hid)
      }
    }
  }
}
