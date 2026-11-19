import { contextBridge, ipcRenderer } from 'electron'
import type { NeedsYouBridge } from '../shared/needsYouBridge'

/** Every method is one request on the channel `pb:needsYou:<method>`, served in src/main/needsYou/ipc.ts. */
const bridge: NeedsYouBridge = {
  waits: () => ipcRenderer.invoke('pb:needsYou:waits'),
  peek: (nodeId) => ipcRenderer.invoke('pb:needsYou:peek', nodeId)
}

export function exposeNeedsYou(): void {
  contextBridge.exposeInMainWorld('patchbayNeedsYou', bridge)
}
