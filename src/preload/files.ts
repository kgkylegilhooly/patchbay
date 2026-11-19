import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { FilesBridge, FilesSummary } from '../shared/filesTouched'

/** Requests on `pb:files:<method>`, served in src/main/files/setup.ts, and the chip counts pushed on `pb:files:summary`. */
const filesBridge: FilesBridge = {
  get: (nodeId) => ipcRenderer.invoke('pb:files:get', nodeId),
  diff: (nodeId, path, scope) => ipcRenderer.invoke('pb:files:diff', nodeId, path, scope),
  summary: () => ipcRenderer.invoke('pb:files:summary'),
  onSummary(cb) {
    const listener = (_e: IpcRendererEvent, summary: FilesSummary): void => cb(summary)
    ipcRenderer.on('pb:files:summary', listener)
    return () => ipcRenderer.removeListener('pb:files:summary', listener)
  }
}

export function exposeFiles(): void {
  contextBridge.exposeInMainWorld('patchbayFiles', filesBridge)
}
