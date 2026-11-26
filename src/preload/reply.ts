import { contextBridge, ipcRenderer } from 'electron'

/** Copy last reply, Save conversation and Reveal transcript: main reads the agent's transcript. Served in src/main/lastReply.ts. */
export function exposeReply(): void {
  contextBridge.exposeInMainWorld('patchbayReply', {
    copyLast: (nodeId: string): Promise<{ ok: true; chars: number } | { ok: false; reason: string }> => ipcRenderer.invoke('pb:reply:copyLast', nodeId),
    saveConversation: (nodeId: string): Promise<{ ok: true; path: string; messages: number } | { ok: false; reason: string; cancelled?: true }> =>
      ipcRenderer.invoke('pb:reply:saveConversation', nodeId),
    revealTranscript: (nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }> => ipcRenderer.invoke('pb:reply:revealTranscript', nodeId)
  })
}
