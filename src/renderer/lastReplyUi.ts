import { say } from './reader/readerUi'

declare global {
  interface Window {
    /** See src/preload/reply.ts. */
    patchbayReply?: { copyLast(nodeId: string): Promise<{ ok: true; chars: number } | { ok: false; reason: string }> }
  }
}

/** Puts an agent's latest reply on the clipboard, and says so, or why not. */
export async function copyLastReply(nodeId: string): Promise<void> {
  const r = await window.patchbayReply?.copyLast(nodeId)
  if (r) say(r.ok ? `Copied the last reply (${r.chars.toLocaleString()} characters).` : r.reason, r.ok)
}
