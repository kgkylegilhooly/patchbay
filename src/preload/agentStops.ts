import { contextBridge, ipcRenderer } from 'electron'
import type { AgentStopBridge } from '../shared/agentStop'

/** Why agents stopped on StopFailure, such as a usage limit. Served in src/main/agentStopsIpc.ts. */
export function exposeAgentStops(): void {
  const bridge: AgentStopBridge = {
    all: () => ipcRenderer.invoke('pb:stops:all'),
    onChange(cb) {
      const handler = (_e: unknown, id: string, stop: Parameters<typeof cb>[1]): void => cb(id, stop)
      ipcRenderer.on('pb:stops:onChange', handler)
      return () => {
        ipcRenderer.removeListener('pb:stops:onChange', handler)
      }
    }
  }
  contextBridge.exposeInMainWorld('patchbayStops', bridge)
}
