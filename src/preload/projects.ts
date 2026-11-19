import { contextBridge, ipcRenderer } from 'electron'
import { PROJECTS_BRIDGE_METHODS } from '../shared/projects'

/** Every method is one request on the channel `pb:projects:<method>`, served in src/main/projects/ipc.ts. */
const call =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:projects:${name}`, ...args) as Promise<never>

export function exposeProjects(): void {
  contextBridge.exposeInMainWorld('patchbayProjects', Object.fromEntries(PROJECTS_BRIDGE_METHODS.map((n) => [n, call(n)])))
}
