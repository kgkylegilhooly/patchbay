import { say } from './reader/readerUi'

declare global {
  interface Window {
    /** See src/preload/reply.ts. */
    patchbayReply?: {
      copyLast(nodeId: string): Promise<{ ok: true; chars: number } | { ok: false; reason: string }>
      saveConversation(nodeId: string): Promise<{ ok: true; path: string; messages: number } | { ok: false; reason: string; cancelled?: true }>
      revealTranscript(nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }>
      headline(nodeId: string): Promise<string | null>
      saveOutput(nodeId: string): Promise<{ ok: true; path: string; lines: number } | { ok: false; reason: string; cancelled?: true }>
    }
  }
}

/** Puts an agent's latest reply on the clipboard, and says so, or why not. */
export async function copyLastReply(nodeId: string): Promise<void> {
  const r = await window.patchbayReply?.copyLast(nodeId)
  if (r) say(r.ok ? `Copied the last reply (${r.chars.toLocaleString()} characters).` : r.reason, r.ok)
}

/** Writes the conversation as Markdown where the person picks, and says where, or why not. A cancel says nothing. */
export async function saveConversation(nodeId: string): Promise<void> {
  const r = await window.patchbayReply?.saveConversation(nodeId)
  if (!r || (!r.ok && r.cancelled)) return
  say(r.ok ? `Saved ${r.messages.toLocaleString()} messages to ${r.path}.` : r.reason, r.ok)
}

/** Writes a terminal's or run's output as a text file where the person picks, and says where, or why not. */
export async function saveOutput(nodeId: string): Promise<void> {
  const r = await window.patchbayReply?.saveOutput(nodeId)
  if (!r || (!r.ok && r.cancelled)) return
  say(r.ok ? `Saved ${r.lines.toLocaleString()} lines to ${r.path}.` : r.reason, r.ok)
}

/** Shows the agent's transcript file in Explorer, or says why it can't. */
export async function revealTranscript(nodeId: string): Promise<void> {
  const r = await window.patchbayReply?.revealTranscript(nodeId)
  if (r && !r.ok) say(r.reason, false)
}
