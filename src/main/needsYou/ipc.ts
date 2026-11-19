import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { CanvasStore } from '../../shared/contract'
import type { WaitSince } from '../../shared/needsYouBridge'
import type { StatusTracker } from '../sessions/statusTracker'
import { peekSession } from './peek'

const REFUSED = 'Peeking is available only in the application UI.'

/**
 * Serves `pb:needsYou:*`, the jump and peek's channels. See src/preload/needsYou.ts. Only the app's own window may
 * ask: a peek is the end of an agent's conversation, and a page in a browser node is no business reading it.
 */
export function registerNeedsYouIpc({ store, tracker, isAppUi }: { store: CanvasStore; tracker: StatusTracker; isAppUi: (e: IpcMainInvokeEvent) => boolean }): void {
  ipcMain.handle('pb:needsYou:waits', (e) => {
    const waits: Record<string, WaitSince> = {}
    if (!isAppUi(e)) return waits
    for (const n of store.get().nodes) {
      const since = tracker.since(n.id)
      if (since) waits[n.id] = since
    }
    return waits
  })
  ipcMain.handle('pb:needsYou:peek', (e, id: unknown) => {
    if (!isAppUi(e)) return { ok: false, reason: REFUSED }
    return peekSession({ doc: () => store.get(), since: (i) => tracker.since(i), status: (i) => tracker.get(i) }, String(id))
  })
}
