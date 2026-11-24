import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AwayByNode } from '../../shared/away'
import { awayMessage, type AwayChanges } from '../../shared/filesTouched'

/**
 * "Changed while it was away" (F13): when a resumed agent's session has started, what changed in its checkout since its
 * last turn ended is kept here and shown on its node. Nothing is sent to the agent until the person presses Tell it.
 * Kept in memory only: it's about this resume.
 */
export interface Away {
  /** A resumed session has started. Looks once, and shows the changes if there are any. */
  resumed(nodeId: string): Promise<void>
  get(): AwayByNode
  tell(nodeId: string): { ok: true } | { ok: false; reason: string }
  dismiss(nodeId: string): void
}

export function createAway(d: {
  changes: (nodeId: string) => Promise<AwayChanges | null>
  send: (nodeId: string, text: string) => { ok: true } | { ok: false; reason: string }
  push: (away: AwayByNode) => void
}): Away {
  const shown = new Map<string, AwayChanges>()
  const publish = (): void => d.push(Object.fromEntries(shown))
  return {
    async resumed(nodeId) {
      const found = await d.changes(nodeId).catch(() => null)
      if (found) shown.set(nodeId, found)
      else if (!shown.delete(nodeId)) return
      publish()
    },
    get: () => Object.fromEntries(shown),
    tell(nodeId) {
      const found = shown.get(nodeId)
      if (!found) return { ok: false, reason: 'There is nothing to tell it.' }
      const sent = d.send(nodeId, awayMessage(found))
      if (!sent.ok) return sent
      shown.delete(nodeId)
      publish()
      return { ok: true }
    },
    dismiss(nodeId) {
      if (shown.delete(nodeId)) publish()
    }
  }
}

/** pb:away:*, for the app's own window only. */
export function serveAway(away: Away, isAppUi: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('pb:away:get', (e) => (isAppUi(e) ? away.get() : {}))
  ipcMain.handle('pb:away:tell', (e, nodeId: unknown) => (isAppUi(e) && typeof nodeId === 'string' ? away.tell(nodeId) : { ok: false, reason: 'Not allowed.' }))
  ipcMain.handle('pb:away:dismiss', (e, nodeId: unknown) => {
    if (isAppUi(e) && typeof nodeId === 'string') away.dismiss(nodeId)
  })
}
