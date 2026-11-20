import { contextBridge, ipcRenderer } from 'electron'
import type { SearchBridge } from '../shared/searchBridge'

/** Every method is one request on the channel `pb:search:<method>`, served in src/main/search/ipc.ts. */
const call =
  (name: keyof SearchBridge) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:search:${name}`, ...args) as Promise<never>

const searchBridge: SearchBridge = {
  search: call('search'),
  stats: call('stats'),
  readSource: call('readSource'),
  rebuild: call('rebuild'),
  prepareHandoff: call('prepareHandoff'),
  startHandoff: call('startHandoff'),
  saveHandoff: call('saveHandoff')
}

export function exposeSearch(): void {
  contextBridge.exposeInMainWorld('patchbaySearch', searchBridge)
}
