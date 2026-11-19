import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FileShelfBridge } from '../shared/fileShelf'

const call =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:files:${name}`, ...args) as Promise<never>

/** Every call is one request on `pb:files:<method>`, served in src/main/fileShelf/ipc.ts. */
const files: FileShelfBridge = {
  list: call('list'),
  note: call('note'),
  forget: call('forget'),
  check: call('check'),
  open: call('open'),
  reveal: call('reveal'),
  onChanged: (cb) => {
    const listener = (_e: unknown, projectId: string): void => cb(projectId)
    ipcRenderer.on('pb:files:changed', listener)
    return () => ipcRenderer.removeListener('pb:files:changed', listener)
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}

export function exposeFileShelf(): void {
  contextBridge.exposeInMainWorld('patchbayFiles', files)
}
