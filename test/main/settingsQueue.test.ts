import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { readIfPresent, writeAtomic } from '../../src/core/persist/atomicFile'
import { inSettingsQueue } from '../../src/main/settingsQueue'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('two settings changes at once both land, rather than the second undoing the first', async () => {
  dir = mkdtempSync(join(tmpdir(), 'pb-settings-'))
  const file = join(dir, 'settings.json')
  writeFileSync(file, '{}')
  const change = (key: string) =>
    inSettingsQueue(async () => {
      const now = JSON.parse((await readIfPresent(file)) ?? '{}') as Record<string, unknown>
      await new Promise((r) => setTimeout(r, 20))
      await writeAtomic(file, JSON.stringify({ ...now, [key]: true }))
    })
  await Promise.all([change('sound'), change('notifications'), change('keepAwake')])
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ sound: true, notifications: true, keepAwake: true })
})

test('a change that fails does not stop the ones after it', async () => {
  await expect(inSettingsQueue(async () => { throw new Error('bad') })).rejects.toThrow('bad')
  expect(await inSettingsQueue(async () => 'next')).toBe('next')
})
