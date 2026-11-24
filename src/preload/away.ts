import { contextBridge, ipcRenderer } from 'electron'
import type { AwayBridge, AwayByNode } from '../shared/away'

/** What changed while a resumed agent was away, and its Tell it and Dismiss. Served in src/main/files/away.ts. */
export function exposeAway(): void {
  const bridge: AwayBridge = {
    get: () => ipcRenderer.invoke('pb:away:get'),
    tell: (nodeId) => ipcRenderer.invoke('pb:away:tell', nodeId),
    dismiss: (nodeId) => ipcRenderer.invoke('pb:away:dismiss', nodeId),
    onChange(cb) {
      const handler = (_e: unknown, away: AwayByNode): void => cb(away)
      ipcRenderer.on('pb:away:onChange', handler)
      return () => {
        ipcRenderer.removeListener('pb:away:onChange', handler)
      }
    }
  }
  contextBridge.exposeInMainWorld('patchbayAway', bridge)
}
