import { contextBridge, ipcRenderer } from 'electron'
import type { RunFixResult } from '../shared/runFix'

/** Copy last reply, Save conversation and Reveal transcript: main reads the agent's transcript. Served in src/main/lastReply.ts. */
export function exposeReply(): void {
  contextBridge.exposeInMainWorld('patchbayReply', {
    copyLast: (nodeId: string): Promise<{ ok: true; chars: number } | { ok: false; reason: string }> => ipcRenderer.invoke('pb:reply:copyLast', nodeId),
    saveConversation: (nodeId: string): Promise<{ ok: true; path: string; messages: number } | { ok: false; reason: string; cancelled?: true }> =>
      ipcRenderer.invoke('pb:reply:saveConversation', nodeId),
    revealTranscript: (nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }> => ipcRenderer.invoke('pb:reply:revealTranscript', nodeId),
    // Save output (F43): a terminal's or run's output as a text file. Served in src/main/saveOutput.ts.
    saveOutput: (nodeId: string): Promise<{ ok: true; path: string; lines: number } | { ok: false; reason: string; cancelled?: true }> => ipcRenderer.invoke('pb:output:save', nodeId)
  })
  // Ask an agent to fix: a failed run's brief. Served in src/main/runFix.ts.
  contextBridge.exposeInMainWorld('patchbayRunFix', {
    brief: (nodeId: string): Promise<RunFixResult> => ipcRenderer.invoke('pb:run:fixBrief', nodeId)
  })
}
