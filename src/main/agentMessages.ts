import type { CanvasStore } from '../shared/contract'
import type { AgentStatus } from '../shared/model'
import { plainText, type SendQueue } from './control/sendQueue'

export type SendResult = { ok: true; queued: boolean } | { ok: false; reason: string }

/**
 * Sends the person's own message to an agent window, from a review or design mode. It waits its turn in the same
 * queue as `patchbay send` and triggers, so a busy agent gets it once it's idle.
 */
export function sendToAgent(deps: { store: CanvasStore; status: (id: string) => AgentStatus | undefined; queue: SendQueue }, id: string, raw: string): SendResult {
  const node = deps.store.get().nodes.find((n) => n.id === id)
  if (node?.kind !== 'claude') return { ok: false, reason: 'That window is not an agent.' }
  if (deps.status(id) === 'exited') return { ok: false, reason: `${node.title} has exited. Restart it first.` }
  const text = plainText(raw).trim()
  if (!text) return { ok: false, reason: 'There is nothing to send.' }
  return { ok: true, queued: deps.queue.add(id, { text }) === 'queued' }
}
