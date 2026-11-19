import { ipcMain, type WebContents } from 'electron'
import { reportViewArea } from './viewSize'

/** Takes the canvas page's visible area on `pb:view:area` (see src/preload/view.ts), from the app's own window only. */
export function registerViewIpc(isApp: (sender: WebContents) => boolean): void {
  ipcMain.on('pb:view:area', (e, area: unknown) => {
    if (isApp(e.sender)) reportViewArea(area)
  })
}
