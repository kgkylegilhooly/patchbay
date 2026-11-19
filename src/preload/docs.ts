import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DocsBridge } from '../shared/reader'

/** Every method is one request on `pb:docs:<method>`, served in src/main/reader/ipc.ts. */
const call =
  (name: keyof DocsBridge) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:docs:${name}`, ...args) as Promise<never>

const docsBridge: DocsBridge & {
  onChanged(cb: (path: string) => void): () => void
  /** The path of a file dropped on the window. The page itself can't see it. */
  pathOfFile(file: File): string
} = {
  read: call('read'),
  open: call('open'),
  pick: call('pick'),
  openPlan: call('openPlan'),
  comments: call('comments'),
  saveComments: call('saveComments'),
  openLink: call('openLink'),
  onChanged(cb) {
    const handler = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('pb:docs:changed', handler)
    return () => {
      ipcRenderer.removeListener('pb:docs:changed', handler)
    }
  },
  pathOfFile: (file) => webUtils.getPathForFile(file)
}

export function exposeDocs(): void {
  contextBridge.exposeInMainWorld('patchbayDocs', docsBridge)
}
