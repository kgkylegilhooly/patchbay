import { contextBridge, ipcRenderer } from 'electron'

/** Tells main which part of the canvas the person can see, so nodes it adds land there. Served in src/main/viewIpc.ts. */
export function exposeView(): void {
  contextBridge.exposeInMainWorld('patchbayView', {
    reportArea: (area: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('pb:view:area', area)
  })
}
