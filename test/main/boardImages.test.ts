import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { MAX_IMAGE_BYTES, readBoardImage, saveBoardImage } from '../../src/main/boardImages'

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
