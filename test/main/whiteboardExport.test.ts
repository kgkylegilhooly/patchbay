import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createWhiteboardExporter, isPng } from '../../src/main/whiteboardExport'
import type { WhiteboardNode } from '../../src/shared/model'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const board: WhiteboardNode = {
  id: 'board-1234-5678',
  kind: 'whiteboard',
  title: 'Sketch',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  parentId: null,
  shapes: [{ type: 'text', color: '#000', size: 2, x: 10, y: 10, text: 'API' }]
}

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'pb-boards-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('saves the SVG and the PNG the window drew, and says what is on the board', async () => {
  const asked: Array<[number, number]> = []
  const exporter = createWhiteboardExporter({ dir, render: async (_svg, w, h) => (asked.push([w, h]), PNG) })
  const out = await exporter.export(board)
  expect(asked).toEqual([[386, 216]])
  expect(out).toMatchObject({ width: 386, height: 216, shapes: { text: 1 }, texts: ['API'] })
  expect(readFileSync(out.image!)).toEqual(Buffer.from(PNG))
  expect(readFileSync(out.svg, 'utf8')).toContain('>API</tspan>')
})

test('anything but a PNG from the window is not written, and the SVG is still there', async () => {
  for (const reply of [null, new Uint8Array([1, 2, 3]), 'not bytes', Promise.reject(new Error('gone'))]) {
    const exporter = createWhiteboardExporter({ dir, render: () => Promise.resolve(reply) })
    const out = await exporter.export(board)
    expect(out.image).toBeNull()
    expect(existsSync(out.svg)).toBe(true)
  }
  expect(isPng(PNG)).toBe(true)
})

test('only the newest exports are kept', async () => {
  const exporter = createWhiteboardExporter({ dir, render: async () => PNG })
  const first = await exporter.export(board)
  const old = new Date(Date.now() - 60_000)
  utimesSync(first.svg, old, old)
  utimesSync(first.image!, old, old)
  for (let i = 0; i < 50; i++) await exporter.export({ ...board, id: `${String(i).padStart(8, '0')}-board` })
  const files = readdirSync(dir)
  expect(files).toHaveLength(100)
  expect(existsSync(first.svg)).toBe(false)
})
