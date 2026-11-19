import { contextBridge, ipcRenderer } from 'electron'
import type { CompareBridge } from '../shared/compare'

/** Every method is one request on the channel `pb:compare:<method>`, served in src/main/compare/ipc.ts. */
const call =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:compare:${name}`, ...args) as Promise<never>

const names: (keyof CompareBridge)[] = ['inspect', 'start', 'list', 'get', 'state', 'diff', 'verify', 'choose', 'remove', 'forget']

export function exposeCompare(): void {
  contextBridge.exposeInMainWorld('patchbayCompare', Object.fromEntries(names.map((n) => [n, call(n)])))
}
