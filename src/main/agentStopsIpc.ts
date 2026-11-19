import { ipcMain } from 'electron'
import { broadcast } from './ipc'
import type { AgentStops } from './sessions/agentStops'

/** Serves `pb:stops:all` and pushes `pb:stops:onChange`. See src/preload/agentStops.ts. */
export function registerAgentStopIpc(stops: AgentStops): void {
  ipcMain.handle('pb:stops:all', () => stops.all())
  stops.onChange((id, stop) => broadcast('pb:stops:onChange', id, stop))
}
