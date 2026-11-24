import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readIfPresent, writeAtomic } from './atomicFile'
import { parseDoc } from './docStore'
import type { CanvasCopy } from '../../shared/canvasHistory'

/**
 * A copy of the canvas a day, for a week: one backup (canvas.json.bak) can't undo a bad day, such as a tidy or a mass
 * close noticed tomorrow. Copies live in <data>/canvas-history, apart from the save file and its backup, and are only
 * ever made from a save file that loads. Restoring puts the current canvas aside there first, so it can be undone.
 */

export const HISTORY_DIR = 'canvas-history'
export const KEEP_COPIES = 7
const DAILY = /^canvas-(\d{4}-\d{2}-\d{2})\.json$/

export type { CanvasCopy } from '../../shared/canvasHistory'

/** A local date as YYYY-MM-DD. */
export function dayStamp(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/** Today's copy of a save file that loads, unless there's one already. The oldest go past KEEP_COPIES. Returns its name. */
export async function keepDailyCopy(dataDir: string, now = new Date()): Promise<string | null> {
  const text = await readIfPresent(join(dataDir, 'canvas.json'))
  if (text === null || !parseDoc(text)) return null
  const dir = join(dataDir, HISTORY_DIR)
  const name = `canvas-${dayStamp(now)}.json`
  if (await stat(join(dir, name)).then(() => true, () => false)) return null
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, name), text)
  const daily = (await readdir(dir)).filter((f) => DAILY.test(f)).sort()
  for (const old of daily.slice(0, Math.max(0, daily.length - KEEP_COPIES))) await rm(join(dir, old), { force: true })
  return name
}

/** The daily copies, newest first, with what each holds. One that doesn't load is left out. */
export async function listCanvasCopies(dataDir: string): Promise<CanvasCopy[]> {
  const dir = join(dataDir, HISTORY_DIR)
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => DAILY.test(f)).sort().reverse()
  const out: CanvasCopy[] = []
  for (const name of names) {
    const path = join(dir, name)
    const doc = parseDoc((await readIfPresent(path)) ?? '')
    const info = await stat(path).catch(() => null)
    if (!doc || !info) continue
    out.push({ name, day: DAILY.exec(name)![1], savedAt: info.mtimeMs, windows: doc.nodes.filter((n) => n.kind !== 'group').length, projects: doc.projects.length })
  }
  return out
}

/**
 * Makes a daily copy the save file, after setting the current one aside in the history folder. The app must not save
 * between this and its restart, or it would write the old canvas back. Only a daily copy's own name is taken.
 */
export async function restoreCanvasCopy(dataDir: string, name: string, now = Date.now()): Promise<{ ok: true; setAside: string | null } | { ok: false; reason: string }> {
  if (!DAILY.test(name)) return { ok: false, reason: 'That is not a canvas copy.' }
  const dir = join(dataDir, HISTORY_DIR)
  const text = await readIfPresent(join(dir, name))
  if (text === null) return { ok: false, reason: 'That copy is gone.' }
  if (!parseDoc(text)) return { ok: false, reason: "That copy can't be read, so nothing was changed." }
  const current = await readIfPresent(join(dataDir, 'canvas.json'))
  let setAside: string | null = null
  if (current !== null) {
    setAside = `canvas-before-restore-${now}.json`
    await writeAtomic(join(dir, setAside), current)
  }
  await writeAtomic(join(dataDir, 'canvas.json'), text)
  return { ok: true, setAside }
}
