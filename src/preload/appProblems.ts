import { contextBridge, ipcRenderer } from 'electron'
import type { AppProblems, AppProblemsBridge } from '../shared/appProblems'

/** Can't save, background sessions stopped: banners in the window. Served in src/main/appProblems.ts. */
export function exposeAppProblems(): void {
  const bridge: AppProblemsBridge = {
    get: () => ipcRenderer.invoke('pb:problems:get'),
    bringBackHost: () => ipcRenderer.invoke('pb:problems:bringBackHost'),
    dismissHostLost: () => ipcRenderer.invoke('pb:problems:dismissHostLost'),
    onChange(cb) {
      const handler = (_e: unknown, problems: AppProblems): void => cb(problems)
      ipcRenderer.on('pb:problems:onChange', handler)
      return () => {
        ipcRenderer.removeListener('pb:problems:onChange', handler)
      }
    }
  }
  contextBridge.exposeInMainWorld('patchbayProblems', bridge)
}
