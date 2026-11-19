import { ipcMain } from 'electron'
import type { CanvasStore } from '../../shared/contract'
import type { WaitSince } from '../../shared/needsYouBridge'
import type { StatusTracker } from '../sessions/statusTracker'
import { peekSession } from './peek'

/** Serves `pb:needsYou:*`, the jump and peek's channels. See src/preload/needsYou.ts. */
export function registerNeedsYouIpc({ store, tracker }: { store: CanvasStore; tracker: StatusTracker }): void {
  ipcMain.handle('pb:needsYou:waits', () => {
    const waits: Record<string, WaitSince> = {}
    for (const n of store.get().nodes) {
      const since = tracker.since(n.id)
      if (since) waits[n.id] = since
    }
    return waits
  })
  ipcMain.handle('pb:needsYou:peek', (_e, id: unknown) => peekSession({ doc: () => store.get(), since: (i) => tracker.since(i) }, String(id)))
}
