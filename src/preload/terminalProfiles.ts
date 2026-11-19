import { contextBridge, ipcRenderer } from 'electron'
import type { TerminalProfileBridge } from '../shared/terminalProfiles'

/** Served in src/main/terminalProfilesIpc.ts. */
export function exposeTerminalProfiles(): void {
  const bridge: TerminalProfileBridge = {
    list: () => ipcRenderer.invoke('pb:terminalProfiles:list'),
    save: (profiles, defaultId) => ipcRenderer.invoke('pb:terminalProfiles:save', profiles, defaultId)
  }
  contextBridge.exposeInMainWorld('patchbayTerminalProfiles', bridge)
}
