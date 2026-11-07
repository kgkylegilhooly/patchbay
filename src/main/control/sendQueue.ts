import type { SessionHost } from '../../shared/contract'
import type { StatusTracker } from '../sessions/statusTracker'

export interface SendTiming {
  /** Claude takes text and Enter arriving in one chunk as a paste, so Enter follows separately. */
  enterDelayMs: number
  /** How long a delivered message may leave a node looking idle before the next one goes anyway. */
  settleMs: number
}

export const DEFAULT_SEND_TIMING: SendTiming = { enterDelayMs: 200, settleMs: 3000 }

export interface SendItem {
  text: string
  /** Asked just before it's typed. Saying no drops it rather than delivering something no longer wanted. */
  stillWanted?: () => boolean
  /** Only for an item that had to wait. One delivered at once is reported by add's result. */
  onDelivered?: () => void
  onDropped?: () => void
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
  timing = DEFAULT_SEND_TIMING
}: {
  host: Pick<SessionHost, 'write' | 'isRunning'>
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  /** Whether the node is still on the canvas. */
  exists: (id: string) => boolean
  timing?: SendTiming
}): SendQueue {
  const queues = new Map<string, SendItem[]>()
  /** Nodes just typed into, whose status can't yet show that they took it. */
  const settling = new Map<string, NodeJS.Timeout>()

  const stopSettling = (id: string): void => {
    const timer = settling.get(id)
    if (timer) clearTimeout(timer)
    settling.delete(id)
  }

  const type = (id: string, text: string): void => {
    host.write(id, text)
    setTimeout(() => host.write(id, '\r'), timing.enterDelayMs)
  }

  const deliverNext = (id: string): void => {
    const queue = queues.get(id)
    if (!queue?.length) return
    if (!exists(id)) {
      queues.delete(id)
      for (const item of queue) item.onDropped?.()
      return
    }
    if (settling.has(id) || tracker.get(id) !== 'idle' || !host.isRunning(id)) return
    let item = queue.shift()
    while (item?.stillWanted && !item.stillWanted()) {
      item.onDropped?.()
      item = queue.shift()
    }
    if (!item) return
    type(id, item.text)
    const timer = setTimeout(() => {
      settling.delete(id)
      deliverNext(id)
    }, timing.settleMs)
    timer.unref?.()
    settling.set(id, timer)
    item.onDelivered?.()
  }

  tracker.onChange((id, status) => {
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
    type,
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
      stopSettling(id)
    }
  }
}
