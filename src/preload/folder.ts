import { contextBridge, ipcRenderer } from 'electron'

/** A window's folder in Explorer or VS Code. Served in src/main/openFolder.ts. */
export function exposeFolder(): void {
  contextBridge.exposeInMainWorld('patchbayFolder', {
    hasVsCode: (): Promise<boolean> => ipcRenderer.invoke('pb:folder:hasVsCode'),
    open: (nodeId: string, how: 'explorer' | 'vscode'): Promise<{ ok: true } | { ok: false; reason: string }> => ipcRenderer.invoke('pb:folder:open', nodeId, how)
  })
}
