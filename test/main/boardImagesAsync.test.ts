import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { clearBoardImageCache, MAX_IMAGE_BYTES, pruneBoardImagesAsync, readBoardImage, readBoardImageAsync, saveBoardImage, saveBoardImageAsync } from '../../src/main/boardImages'

let dir: string
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'pb-images-async-')), 'images')
  clearBoardImageCache()
})
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])

test('saving and reading off the main thread give the same names and data URLs as before', async () => {
  const file = await saveBoardImageAsync(dir, bytes, 'image/png')
  expect(file).toBe(saveBoardImage(join(dir, '..', 'sync'), bytes, 'image/png'))
  expect(await saveBoardImageAsync(dir, bytes, 'image/png')).toBe(file)
  expect(readdirSync(dir)).toEqual([file])
  expect(await readBoardImageAsync(dir, file)).toBe(readBoardImage(dir, file))
  await expect(saveBoardImageAsync(dir, bytes, 'image/svg+xml')).rejects.toThrow(/kind of picture/)
  await expect(saveBoardImageAsync(dir, new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png')).rejects.toThrow(/over/)
  expect(await readBoardImageAsync(dir, '../../canvas.json')).toBeNull()
  expect(await readBoardImageAsync(dir, `${'0'.repeat(64)}.png`)).toBeNull()
})

test('a picture read once is served from memory after, since its name always means the same picture', async () => {
  const file = await saveBoardImageAsync(dir, bytes, 'image/png')
  const first = await readBoardImageAsync(dir, file)
  rmSync(join(dir, file))
  expect(await readBoardImageAsync(dir, file)).toBe(first)
  clearBoardImageCache()
  expect(await readBoardImageAsync(dir, file)).toBeNull()
})

test('pruning later, off the thread, removes only what was unused at start-up and is a day old', async () => {
  const used = saveBoardImage(dir, bytes, 'image/png')
  const stale = saveBoardImage(dir, new Uint8Array([1, 2]), 'image/png')
  const fresh = saveBoardImage(dir, new Uint8Array([3, 4]), 'image/png')
  writeFileSync(join(dir, 'notes.txt'), 'keep me')
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000)
  for (const f of [stale, used]) utimesSync(join(dir, f), old, old)
  expect(await pruneBoardImagesAsync(dir, new Set([used]))).toBe(1)
  expect(readdirSync(dir).sort()).toEqual([used, fresh, 'notes.txt'].sort())
  expect(await pruneBoardImagesAsync(join(dir, 'missing'), new Set())).toBe(0)
})
