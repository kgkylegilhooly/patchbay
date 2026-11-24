import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { removeTemp } from '../support/realProcess'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
const { serveCanvasHistory } = await import('../../src/main/canvasHistoryIpc')

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const s of stops.splice(0)) s()
  handlers.clear()
  for (const d of dirs.splice(0)) await removeTemp(d)
})

const docWith = (title: string) =>
  JSON.stringify({
    version: 3,
    projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: [{ kind: 'terminal', id: 'n', title, x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p', cwd: 'C:/a' }],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })

async function world(blocked: string | null = null) {
  const data = mkdtempSync(join(tmpdir(), 'pb-history-ipc-'))
  dirs.push(data)
  writeFileSync(join(data, 'canvas.json'), docWith('then'))
  const sealed = vi.fn(async () => {})
  const relaunch = vi.fn()
  stops.push(serveCanvasHistory({ dataDir: data, isAppUi: (e) => (e as { app?: boolean }).app === true, restartBlocked: () => blocked, flushAndSeal: sealed, relaunch }))
  // The copy made at start.
  await vi.waitFor(async () => expect((await handlers.get('pb:history:list')!({ app: true })) as unknown[]).toHaveLength(1))
  writeFileSync(join(data, 'canvas.json'), docWith('now'))
  const [copy] = (await handlers.get('pb:history:list')!({ app: true })) as Array<{ name: string }>
  return { data, sealed, relaunch, copy, restore: (name: string, e: unknown = { app: true }) => handlers.get('pb:history:restore')!(e, name) }
}

test('a restore seals saving, puts the copy in place and restarts', async () => {
  const w = await world()
  expect(await w.restore(w.copy.name)).toEqual({ ok: true })
  expect(w.sealed).toHaveBeenCalledTimes(1)
  expect(JSON.parse(readFileSync(join(w.data, 'canvas.json'), 'utf8')).nodes[0].title).toBe('then')
  await vi.waitFor(() => expect(w.relaunch).toHaveBeenCalledTimes(1))
})

test('running work, a bad name, a damaged copy or another sender change nothing and seal nothing', async () => {
  const busy = await world('An agent is still working.')
  expect(await busy.restore(busy.copy.name)).toEqual({ ok: false, reason: 'An agent is still working.' })
  const w = await world()
  expect(await w.restore('..\\canvas.json')).toMatchObject({ ok: false })
  writeFileSync(join(w.data, 'canvas-history', w.copy.name), 'broken')
  expect(await w.restore(w.copy.name)).toEqual({ ok: false, reason: "That copy can't be read, so nothing was changed." })
  expect(await w.restore(w.copy.name, { app: false })).toEqual({ ok: false, reason: 'Not allowed.' })
  for (const x of [busy, w]) {
    expect(x.sealed).not.toHaveBeenCalled()
    expect(x.relaunch).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(x.data, 'canvas.json'), 'utf8')).nodes[0].title).toBe('now')
  }
})
