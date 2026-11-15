import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { MAX_IMAGE_BYTES, pruneBoardImages, readBoardImage, saveBoardImage } from '../../src/main/boardImages'

let dir: string
beforeEach(() => (dir = join(mkdtempSync(join(tmpdir(), 'pb-images-')), 'images')))
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

test('a picture is saved once under the name of its content, and read back as a data URL', () => {
  const file = saveBoardImage(dir, bytes, 'image/png')
  expect(file).toMatch(/^[0-9a-f]{64}\.png$/)
  expect(saveBoardImage(dir, bytes, 'image/png')).toBe(file)
  expect(readdirSync(dir)).toEqual([file])
  expect(readBoardImage(dir, file)).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
  expect(saveBoardImage(dir, bytes, 'image/jpeg')).toMatch(/\.jpg$/)
})

test('other kinds of file, empty or huge pictures are refused, and only saved names can be read', () => {
  expect(() => saveBoardImage(dir, bytes, 'image/svg+xml')).toThrow(/kind of picture/)
  expect(() => saveBoardImage(dir, new Uint8Array(), 'image/png')).toThrow(/empty/)
  expect(() => saveBoardImage(dir, new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png')).toThrow(/over/)
  expect(readBoardImage(dir, '../../canvas.json')).toBeNull()
  expect(readBoardImage(dir, `${'0'.repeat(64)}.png`)).toBeNull()
})

test('pictures no board uses are deleted once a day old, and nothing else in the folder is touched', () => {
  const used = saveBoardImage(dir, bytes, 'image/png')
  const stale = saveBoardImage(dir, new Uint8Array([1, 2]), 'image/png')
  const fresh = saveBoardImage(dir, new Uint8Array([3, 4]), 'image/png')
  writeFileSync(join(dir, 'notes.txt'), 'keep me')
  const day = 24 * 60 * 60_000
  utimesSync(join(dir, stale), new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day))
  utimesSync(join(dir, used), new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day))
  expect(pruneBoardImages(dir, new Set([used]))).toBe(1)
  expect(readdirSync(dir).sort()).toEqual([used, fresh, 'notes.txt'].sort())
  expect(pruneBoardImages(join(dir, 'missing'), new Set())).toBe(0)
})
