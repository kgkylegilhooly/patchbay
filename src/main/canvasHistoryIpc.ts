import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { HISTORY_DIR, keepDailyCopy, listCanvasCopies, restoreCanvasCopy, type CanvasCopy } from '../core/persist/canvasHistory'
import { readIfPresent } from '../core/persist/atomicFile'
import { parseDoc } from '../core/persist/docStore'

/** How often to look whether the day has turned. A look is one stat when today's copy exists. */
const LOOK_EVERY_MS = 60 * 60_000

export type RestoreResult = { ok: true } | { ok: false; reason: string }

/**
 * Canvas history (see core/persist/canvasHistory.ts): a copy at start and on each new day, and File > Restore canvas
 * from. A restore can't be done to the canvas in memory, which would save itself back over the copy, so it's put on
 * disk with saving sealed off, and Patchbay restarts to read it. Sessions keep running across that, as on any restart.
 */
export function serveCanvasHistory(d: {
  dataDir: string
  isAppUi: (e: IpcMainInvokeEvent) => boolean
  /** Why a restart would have to ask about running work now, or null when it can go ahead. */
  restartBlocked: () => string | null
  /** Writes what's pending, then stops every later save. */
  flushAndSeal: () => Promise<void>
  /** Restarts the app through its ordinary quit, leaving sessions running. */
  relaunch: () => void
  log?: (line: string) => void
}): () => void {
  const look = (): void => void keepDailyCopy(d.dataDir).catch((e: unknown) => d.log?.(`Canvas history: today's copy couldn't be made (${String(e)}).`))
  look()
  const timer = setInterval(look, LOOK_EVERY_MS)
  timer.unref?.()

  ipcMain.handle('pb:history:list', (e): Promise<CanvasCopy[]> | CanvasCopy[] => (d.isAppUi(e) ? listCanvasCopies(d.dataDir) : []))
  ipcMain.handle('pb:history:restore', async (e, name: unknown): Promise<RestoreResult> => {
    if (!d.isAppUi(e) || typeof name !== 'string') return { ok: false, reason: 'Not allowed.' }
    const blocked = d.restartBlocked()
    if (blocked) return { ok: false, reason: blocked }
    // Checked before anything is sealed, so a bad copy leaves the app saving as usual.
    if (!/^canvas-\d{4}-\d{2}-\d{2}\.json$/.test(name) || !parseDoc((await readIfPresent(join(d.dataDir, HISTORY_DIR, name))) ?? '')) {
      return { ok: false, reason: "That copy can't be read, so nothing was changed." }
    }
    await d.flushAndSeal()
    // From here the app restarts whatever happens: it no longer saves, so it mustn't carry on.
    try {
      const r = await restoreCanvasCopy(d.dataDir, name)
      d.log?.(r.ok ? `Canvas history: restored ${name}; the canvas before it is ${r.setAside ?? 'not there'}.` : `Canvas history: ${name} wasn't restored (${r.reason}).`)
    } catch (err) {
      d.log?.(`Canvas history: restoring ${name} failed (${String(err)}); restarting with what's on disk.`)
    }
    setTimeout(d.relaunch, 50)
    return { ok: true }
  })
  return () => clearInterval(timer)
}
