import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { dayStamp, keepDailyCopy, KEEP_COPIES, listCanvasCopies, restoreCanvasCopy } from '../../src/core/persist/canvasHistory'
import { removeTemp } from '../support/realProcess'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-history-'))
  dirs.push(d)
  return d
}

const docWith = (titles: string[]) =>
  JSON.stringify({
    version: 3,
    projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: titles.map((title, i) => ({ kind: 'terminal', id: `n${i}`, title, x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p', cwd: 'C:/a' })),
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })
const day = (d: number) => new Date(2026, 10, d, 9, 0)

test('one copy a day of a canvas that loads, at most a week of them, newest first with what each holds', async () => {
  const data = temp()
  writeFileSync(join(data, 'canvas.json'), docWith(['a', 'b']))
  expect(await keepDailyCopy(data, day(1))).toBe('canvas-2026-11-01.json')
  // The same day again keeps the first copy of it.
  writeFileSync(join(data, 'canvas.json'), docWith(['a']))
  expect(await keepDailyCopy(data, day(1))).toBeNull()
  for (let d = 2; d <= 9; d++) await keepDailyCopy(data, day(d))
  const copies = await listCanvasCopies(data)
  expect(copies).toHaveLength(KEEP_COPIES)
  expect(copies[0]).toMatchObject({ name: 'canvas-2026-11-09.json', day: '2026-11-09', windows: 1, projects: 1 })
  expect(copies.at(-1)?.day).toBe('2026-11-03')
  expect(dayStamp(day(9))).toBe('2026-11-09')
})

test('a save file that does not load is never copied, and a damaged copy is left out of the list', async () => {
  const data = temp()
  writeFileSync(join(data, 'canvas.json'), '{"version": 3, "nodes": ')
  expect(await keepDailyCopy(data, day(1))).toBeNull()
  expect(await listCanvasCopies(data)).toEqual([])
  writeFileSync(join(data, 'canvas.json'), docWith(['a']))
  await keepDailyCopy(data, day(2))
  writeFileSync(join(data, 'canvas-history', 'canvas-2026-11-03.json'), 'not json')
  expect((await listCanvasCopies(data)).map((c) => c.day)).toEqual(['2026-11-02'])
})

test('restoring sets the current canvas aside first, takes only a daily copy by name, and refuses a damaged one', async () => {
  const data = temp()
  writeFileSync(join(data, 'canvas.json'), docWith(['yesterday']))
  await keepDailyCopy(data, day(1))
  writeFileSync(join(data, 'canvas.json'), docWith(['today', 'and more']))

  expect(await restoreCanvasCopy(data, '..\\canvas.json')).toEqual({ ok: false, reason: 'That is not a canvas copy.' })
  writeFileSync(join(data, 'canvas-history', 'canvas-2026-11-05.json'), 'broken')
  expect(await restoreCanvasCopy(data, 'canvas-2026-11-05.json')).toEqual({ ok: false, reason: "That copy can't be read, so nothing was changed." })
  expect(JSON.parse(readFileSync(join(data, 'canvas.json'), 'utf8')).nodes).toHaveLength(2)

  const r = await restoreCanvasCopy(data, 'canvas-2026-11-01.json', 123)
  expect(r).toEqual({ ok: true, setAside: 'canvas-before-restore-123.json' })
  expect(JSON.parse(readFileSync(join(data, 'canvas.json'), 'utf8')).nodes[0].title).toBe('yesterday')
  expect(JSON.parse(readFileSync(join(data, 'canvas-history', 'canvas-before-restore-123.json'), 'utf8')).nodes).toHaveLength(2)
  // The set-aside copy isn't a daily one, so it's never pruned with them.
  expect(readdirSync(join(data, 'canvas-history'))).toContain('canvas-before-restore-123.json')
})
