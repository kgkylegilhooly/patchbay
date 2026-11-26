import type { SessionHost } from '../../shared/contract'
import type { StatusTracker } from '../sessions/statusTracker'
import { asPaste } from '../sessions/paste'

export interface SendTiming {
  /** Enter follows the text separately, after the paste has ended, so it submits rather than adding a line. */
  enterDelayMs: number
  /** How long a delivered message may leave a node looking idle before the next one goes anyway. */
  settleMs: number
  /**
   * When an agent still looks idle this long after Enter, Enter goes once more. Codex on Windows can take a long text
   * and the Enter after it as one paste, leaving the message typed but not sent. Enter on an empty prompt does nothing,
   * so a second one is harmless when the first worked. Absent means no second Enter.
   */
  retryEnterMs?: number
}

export const DEFAULT_SEND_TIMING: SendTiming = { enterDelayMs: 200, settleMs: 3000, retryEnterMs: 1500 }

export interface SendItem {
  text: string
  /** The node that sent it, and what it said without the line naming it, for a message `wait` may hand over. */
  from?: string
  said?: string
  /** Asked just before it's typed. Saying no drops it rather than delivering something no longer wanted. */
  stillWanted?: () => boolean
  /** Only for an item that had to wait. One delivered at once is reported by add's result. */
  onDelivered?: () => void
  onDropped?: () => void
  /** Just after it's typed, before Enter, whether at once or after waiting. Not for one handed over by take. */
  onTyped?: () => void
}

export interface SendQueue {
  /** Types it now if the node is idle, or else holds it until the node next is. */
  add(id: string, item: SendItem): 'delivered' | 'queued'
  /** Types into a session straight away, for a terminal, which has no status to wait for. */
  type(id: string, text: string): void
  /** Takes out everything this says to, reporting each as dropped. */
  drop(match: (id: string, item: SendItem) => boolean): void
  /** Forgets a node, as when it closes. */
  forget(id: string): void
  /** A message is waiting for the node, or was typed so recently its status can't show it yet. */
  busy(id: string): boolean
  /** The messages waiting for a node that match, left where they are. */
  pending(id: string, match: (item: SendItem) => boolean): SendItem[]
  /** Takes waiting messages for a node out of its queue, to be handed over some other way. They count as delivered. */
  take(id: string, match: (item: SendItem) => boolean): SendItem[]
}

/** What's safe to type into Claude: nothing here can press a key at a prompt. Enter is sent separately. */
export function plainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

/**
 * The one line into a session. Everything sent while a Claude node is busy waits here, one message per idle, however it
 * came, so a `patchbay send` and a trigger can't type over each other. Nothing here starts a session.
 */
export function createSendQueue({
  host,
  tracker,
  exists,
  timing = DEFAULT_SEND_TIMING,
  prefix,
  pasteOn,
  draft,
  hold
}: {
  host: Pick<SessionHost, 'write' | 'isRunning'>
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  /** Whether the node is still on the canvas. */
  exists: (id: string) => boolean
  timing?: SendTiming
  /** Put ahead of text typed into a terminal: see sessions/sendGuard.ts. */
  prefix?: (id: string) => string
  /**
   * Whether an agent's screen last turned bracketed paste on or off (see sendGuard.ts). A message to an agent goes as
   * a paste unless this says off: see sessions/paste.ts. Not known, as after reconnecting to a running session, counts
   * as on, since Claude Code and Codex both turn it on.
   */
  pasteOn?: (id: string) => boolean | undefined
  /**
   * What the person is typing at an agent's prompt (see sendGuard.ts). A message waits while they have text there
   * unsent, or it would be added to the end of theirs, and goes once they stop.
   */
  draft?: { drafting(id: string): boolean; onDraftSettled(cb: (id: string) => void): void }
  /**
   * Agents stopped on StopFailure (see sessions/agentStops.ts). One held, as at a usage limit, gets nothing until its
   * reset. One released is at its prompt though its status is `unknown`, so it gets what's waiting.
   */
  hold?: { holding(id: string): boolean; released(id: string): boolean; onRelease(cb: (id: string) => void): void }
}): SendQueue {
  const queues = new Map<string, SendItem[]>()
  /** Nodes just typed into, whose status can't yet show that they took it. */
  const settling = new Map<string, NodeJS.Timeout>()

  const stopSettling = (id: string): void => {
    const timer = settling.get(id)
    if (timer) clearTimeout(timer)
    settling.delete(id)
  }

  /** Agents whose status has moved off idle since they were last typed into, so the message went. */
  const took = new Set<string>()

  /** Idle, or stopped on a failure at its prompt with nothing held. */
  const atPrompt = (id: string): boolean => {
    const status = tracker.get(id)
    if (status === 'idle') return !hold?.holding(id)
    return status === 'unknown' && !!hold?.released(id)
  }

  const type = (id: string, text: string, paste = false): void => {
    took.delete(id)
    host.write(id, (prefix?.(id) ?? '') + (paste ? asPaste(text) : text))
    setTimeout(() => {
      host.write(id, '\r')
      const retry = timing.retryEnterMs
      if (retry === undefined) return
      const timer = setTimeout(() => {
        // A terminal has no status, so this only ever presses Enter again for an agent. Not while the person is typing
        // at that prompt: the status can lag on a busy PC, and Enter then would send their unfinished text (SQ1).
        if (!took.has(id) && atPrompt(id) && host.isRunning(id) && !draft?.drafting(id)) host.write(id, '\r')
      }, retry)
      timer.unref?.()
    }, timing.enterDelayMs)
  }

  const deliverNext = (id: string): void => {
    const queue = queues.get(id)
    if (!queue?.length) return
    if (!exists(id)) {
      queues.delete(id)
      for (const item of queue) item.onDropped?.()
      return
    }
    if (settling.has(id) || !atPrompt(id) || !host.isRunning(id) || draft?.drafting(id)) return
    let item = queue.shift()
    while (item?.stillWanted && !item.stillWanted()) {
      item.onDropped?.()
      item = queue.shift()
    }
    if (!item) return
    type(id, item.text, pasteOn?.(id) !== false)
    item.onTyped?.()
    const timer = setTimeout(() => {
      settling.delete(id)
      deliverNext(id)
    }, timing.settleMs)
    timer.unref?.()
    settling.set(id, timer)
    item.onDelivered?.()
  }

  draft?.onDraftSettled((id) => deliverNext(id))
  hold?.onRelease((id) => deliverNext(id))

  tracker.onChange((id, status) => {
    if (status !== 'idle') took.add(id)
    if (status === 'idle') deliverNext(id)
    else stopSettling(id)
  })

  return {
    add(id, item) {
      const queue = queues.get(id) ?? []
      queues.set(id, queue)
      // Taken off until it's known to have waited, so its callback doesn't run for a delivery add reports itself.
      const waiting: SendItem = { ...item, onDelivered: undefined }
      queue.push(waiting)
      deliverNext(id)
      if (!queue.includes(waiting)) return 'delivered'
      waiting.onDelivered = item.onDelivered
      return 'queued'
    },
    type: (id, text) => type(id, text),
    busy(id) {
      return settling.has(id) || (queues.get(id)?.length ?? 0) > 0
    },
    pending: (id, match) => (queues.get(id) ?? []).filter(match),
    take(id, match) {
      const queue = queues.get(id) ?? []
      const taken = queue.filter(match)
      if (!taken.length) return []
      queues.set(id, queue.filter((item) => !taken.includes(item)))
      for (const item of taken) item.onDelivered?.()
      return taken
    },
    drop(match) {
      for (const [id, queue] of queues) {
        const dropped = queue.filter((item) => match(id, item))
        if (!dropped.length) continue
        queues.set(id, queue.filter((item) => !dropped.includes(item)))
        for (const item of dropped) item.onDropped?.()
      }
    },
    forget(id) {
      queues.delete(id)
      took.delete(id)
      stopSettling(id)
    }
  }
}
