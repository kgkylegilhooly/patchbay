import { contextBridge, ipcRenderer } from 'electron'
import type { DiagnosticsBridge } from '../shared/diagnostics'

/** Settings › About's versions, Copy diagnostics and Open log folder, served in src/main/diagnostics/setup.ts. */
const bridge: DiagnosticsBridge = {
  about: () => ipcRenderer.invoke('pb:diagnostics:about'),
  agents: () => ipcRenderer.invoke('pb:diagnostics:agents'),
  copy: () => ipcRenderer.invoke('pb:diagnostics:copy'),
  openLogFolder: () => ipcRenderer.invoke('pb:diagnostics:openLogFolder')
}

export function exposeDiagnostics(): void {
  contextBridge.exposeInMainWorld('patchbayDiagnostics', bridge)
}
