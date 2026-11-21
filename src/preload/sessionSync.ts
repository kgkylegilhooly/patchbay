import { contextBridge, ipcRenderer } from 'electron'
import type { SessionSyncBridge, SyncReport } from '../shared/sessionSync'

/** Keeping the canvas and the background host in agreement. Served in src/main/sessionSyncIpc.ts. */
export function exposeSessionSync(): void {
  const bridge: SessionSyncBridge = {
    report: () => ipcRenderer.invoke('pb:sync:report'),
    check: () => ipcRenderer.invoke('pb:sync:check'),
    endAndRestart: (id) => ipcRenderer.invoke('pb:sync:endAndRestart', id),
    endOrphan: (id) => ipcRenderer.invoke('pb:sync:endOrphan', id),
    adoptOrphan: (id) => ipcRenderer.invoke('pb:sync:adoptOrphan', id),
    onReport(cb) {
      const handler = (_e: unknown, report: SyncReport): void => cb(report)
      ipcRenderer.on('pb:sync:onReport', handler)
      return () => {
        ipcRenderer.removeListener('pb:sync:onReport', handler)
      }
    },
    onJoined(cb) {
      const handler = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on('pb:sync:onJoined', handler)
      return () => {
        ipcRenderer.removeListener('pb:sync:onJoined', handler)
      }
    }
  }
  contextBridge.exposeInMainWorld('patchbaySync', bridge)
}
