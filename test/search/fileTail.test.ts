import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { readAdded } from '../../src/core/search/fileTail'
import { removeTemp } from '../support/realProcess'

// The search index reads every agent's transcript through this, a piece at a time, as it grows.
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})
const file = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-tail-'))
  dirs.push(d)
  return join(d, 'session.jsonl')
}
const read = async (path: string, cursor?: Parameters<typeof readAdded>[1]) => {
  const parts: string[] = []
  const added = await readAdded(path, cursor, (t) => parts.push(t))
  return { text: parts.join(''), ...added }
}

test('only complete lines are handed over; a line still being written waits for its newline', async () => {
  const path = file()
  writeFileSync(path, '{"a":1}\n{"b":')
  const first = await read(path)
  expect(first).toMatchObject({ text: '{"a":1}\n', fromStart: true })
  appendFileSync(path, '2}\n{"c":3}\n')
  const second = await read(path, first.cursor)
  expect(second).toMatchObject({ text: '{"b":2}\n{"c":3}\n', fromStart: false })
  // Nothing new: nothing handed over, same place.
  const third = await read(path, second.cursor)
  expect(third.text).toBe('')
  expect(third.cursor.offset).toBe(second.cursor.offset)
})

test('a replaced or shortened file is read again from its start', async () => {
  const path = file()
  writeFileSync(path, '{"session":"one"}\n{"x":1}\n')
  const before = await read(path)
  writeFileSync(path, '{"session":"two"}\n')
  expect(await read(path, before.cursor)).toMatchObject({ text: '{"session":"two"}\n', fromStart: true })
  writeFileSync(path, '{"session":"one"}\n')
  // Same start, but shorter than where it was read to: read again too.
  expect(await read(path, before.cursor)).toMatchObject({ text: '{"session":"one"}\n', fromStart: true })
})

test('text in any script comes through whole, and a line longer than a read piece is still read once, whole', async () => {
  const path = file()
  const long = `{"text":"${'é漢🙂'.repeat(600_000)}"}\n`
  writeFileSync(path, `{"t":"naïve café 漢字 🙂"}\n${long}{"end":true}\n`)
  const r = await read(path)
  expect(r.text).toBe(`{"t":"naïve café 漢字 🙂"}\n${long}{"end":true}\n`)
  expect(r.text.includes('�')).toBe(false)
})
