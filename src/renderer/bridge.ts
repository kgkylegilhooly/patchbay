import type { PatchbayBridge } from '../shared/contract'

declare global {
  interface Window {
    patchbay: PatchbayBridge
  }
}

export const bridge: PatchbayBridge = window.patchbay

type OutputCb = (data: string, seq: number) => void
const outputListeners = new Map<string, Set<OutputCb>>()
let listening = false

/** One IPC listener routes output to each node, so a noisy terminal costs only its own node. */
export function subscribeOutput(id: string, cb: OutputCb): () => void {
  if (!listening) {
    listening = true
    bridge.onOutput((nodeId, data, seq) => {
      outputListeners.get(nodeId)?.forEach((l) => l(data, seq))
    })
  }
  let set = outputListeners.get(id)
  if (!set) outputListeners.set(id, (set = new Set()))
  set.add(cb)
  return () => {
    set.delete(cb)
    if (set.size === 0) outputListeners.delete(id)
  }
}
