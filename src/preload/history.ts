import { contextBridge, ipcRenderer } from 'electron'

/** Canvas history's list and restore. Served in src/main/canvasHistoryIpc.ts. */
export function exposeHistory(): void {
  contextBridge.exposeInMainWorld('patchbayHistory', {
    list: () => ipcRenderer.invoke('pb:history:list'),
    restore: (name: string) => ipcRenderer.invoke('pb:history:restore', name)
  })
}
