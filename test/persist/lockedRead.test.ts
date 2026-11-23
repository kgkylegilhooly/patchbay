import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

/** readFile that fails as a file held by antivirus does, as many times as asked. */
const locks = vi.hoisted(() => ({ left: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (locks.left > 0) {
        locks.left--
        throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile
  }
})

const { readIfPresent } = await import('../../src/core/persist/atomicFile')

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'pb-locked-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a locked settings file is retried without holding up the thread', async () => {
  const file = join(dir, 'settings.json')
  writeFileSync(file, '{"a":1}')
  locks.left = 4
  const started = performance.now()
  let timerAt = 0
  const timer = new Promise<void>((r) => setTimeout(() => ((timerAt = performance.now() - started), r()), 0))
  const text = await readIfPresent(file)
  await timer
  expect(text).toBe('{"a":1}')
  // Four retries take about half a second, but everything else ran meanwhile.
  expect(performance.now() - started).toBeGreaterThanOrEqual(400)
  expect(timerAt).toBeLessThan(100)
})

test('a missing file is null, and any other failure still throws', async () => {
  expect(await readIfPresent(join(dir, 'none.json'))).toBeNull()
  locks.left = 99
  await expect(readIfPresent(join(dir, 'none.json'))).rejects.toThrow('locked')
  locks.left = 0
})
