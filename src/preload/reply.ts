import { contextBridge, ipcRenderer } from 'electron'

/** Copy last reply: main reads the agent's transcript and writes the clipboard. Served in src/main/lastReply.ts. */
export function exposeReply(): void {
  contextBridge.exposeInMainWorld('patchbayReply', {
    copyLast: (nodeId: string): Promise<{ ok: true; chars: number } | { ok: false; reason: string }> => ipcRenderer.invoke('pb:reply:copyLast', nodeId)
  })
}
