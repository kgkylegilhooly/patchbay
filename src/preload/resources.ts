import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ResourceReading, ResourcesBridge, ResourceWarning } from '../shared/resources'

const on = <T>(channel: string, cb: (value: T) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** The resource view's calls, served in src/main/resources/setup.ts. */
const bridge: ResourcesBridge = {
  get: (fresh) => ipcRenderer.invoke('pb:resources:get', fresh === true),
  watch: (value) => ipcRenderer.invoke('pb:resources:watch', value === true),
  onReading: (cb) => on<ResourceReading>('pb:resources:reading', cb),
  onWarning: (cb) => on<ResourceWarning>('pb:resources:warning', cb),
  onLowMemory: (cb) => on<void>('pb:resources:low', () => cb())
}

export function exposeResources(): void {
  contextBridge.exposeInMainWorld('patchbayResources', bridge)
}
