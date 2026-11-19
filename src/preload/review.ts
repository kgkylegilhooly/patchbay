import { contextBridge, ipcRenderer } from 'electron'
import { REVIEW_METHODS } from '../shared/reviewInbox'

/** Every method is one request on the channel `pb:review:<method>`, served in src/main/review/ipc.ts. */
export function exposeReview(): void {
  contextBridge.exposeInMainWorld(
    'patchbayReview',
    Object.fromEntries(REVIEW_METHODS.map((n) => [n, (...args: unknown[]) => ipcRenderer.invoke(`pb:review:${n}`, ...args)]))
  )
}
