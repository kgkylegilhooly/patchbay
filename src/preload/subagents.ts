import { contextBridge, ipcRenderer } from 'electron'
import type { SubagentBridge, SubagentSnapshot } from '../shared/subagents'

/** Requests on `pb:subagents:<method>` and the push `pb:subagents:onCards`, served in src/main/subagents/setup.ts. */
const bridge: SubagentBridge = {
  get: () => ipcRenderer.invoke('pb:subagents:get'),
  transcript: (nodeId, agentId) => ipcRenderer.invoke('pb:subagents:transcript', nodeId, agentId),
  onCards(cb) {
    const handler = (_e: unknown, snapshot: SubagentSnapshot): void => cb(snapshot)
    ipcRenderer.on('pb:subagents:onCards', handler)
    return () => {
      ipcRenderer.removeListener('pb:subagents:onCards', handler)
    }
  }
}

export function exposeSubagents(): void {
  contextBridge.exposeInMainWorld('patchbaySubagents', bridge)
}
