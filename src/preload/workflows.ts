import { contextBridge, ipcRenderer } from 'electron'
import type { WorkflowBridge } from '../shared/workflowBridge'
import type { WorkflowRun } from '../shared/workflow'

/** Every method is one request on the channel `pb:workflows:<method>`, served in src/main/workflows/ipc.ts. */
const call =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:workflows:${name}`, ...args) as Promise<never>

const names = ['list', 'preview', 'start', 'runs', 'act', 'save', 'openFolder', 'openFile'] as const

export function exposeWorkflows(): void {
  const bridge = {
    ...Object.fromEntries(names.map((n) => [n, call(n)])),
    onChange(cb: (run: WorkflowRun) => void) {
      const handler = (_e: unknown, run: WorkflowRun): void => cb(run)
      ipcRenderer.on('pb:workflows:onChange', handler)
      return () => {
        ipcRenderer.removeListener('pb:workflows:onChange', handler)
      }
    }
  } as WorkflowBridge
  contextBridge.exposeInMainWorld('patchbayWorkflows', bridge)
}
