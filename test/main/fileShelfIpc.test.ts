import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { memoryStore } from '../control/fakes'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined }, shell: { openPath: async () => '', showItemInFolder: () => undefined } }))
const { registerFileShelfIpc } = await import('../../src/main/fileShelf/ipc')
const { FileShelfStore } = await import('../../src/main/fileShelf/store')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay shelf ipc '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A shelf saved with two projects' lists on it. */
async function savedShelf(): Promise<void> {
  const shelf = new FileShelfStore(join(dir, 'file-shelf.json'), { writeDelayMs: 0 })
  shelf.note('p1', { path: 'C:\\a.png', source: 'paste', at: 1 })
  shelf.note('p2', { path: 'C:\\b.pdf', source: 'drop', at: 2 })
  await shelf.flush()
  await new Promise((r) => setTimeout(r, 20))
  await shelf.flush()
}

const canvasWith = (...ids: string[]) => {
  const store = memoryStore([])
  const doc = store.get()
  ;(doc as { projects: unknown[] }).projects = ids.map((id) => ({ id, name: id, folder: '', viewport: { x: 0, y: 0, zoom: 1 } }))
  return store
}

// FS1a: after both save files were damaged the canvas opens new, with one project, and every other project's shelf
// was dropped at start. index.ts already holds back other clean-ups while the canvas is uncertain (PS1).
test("a shelf whose project isn't on the canvas is dropped at start, unless the canvas is uncertain", async () => {
  await savedShelf()
  const uncertain = registerFileShelfIpc({ dataDir: dir, store: canvasWith('project-1'), isAppUi: () => true, windows: () => [], canvasUncertain: true })
  expect(uncertain.list('p1')).toHaveLength(1)
  expect(uncertain.list('p2')).toHaveLength(1)

  const sure = registerFileShelfIpc({ dataDir: dir, store: canvasWith('p1'), isAppUi: () => true, windows: () => [] })
  expect(sure.list('p1')).toHaveLength(1)
  expect(sure.list('p2')).toEqual([])
})
