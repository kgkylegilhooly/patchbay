import { expect, test } from 'vitest'
import { createMessageLog } from '../../src/main/messageLog'

test('keeps the newest messages, in order, with long texts cut short', () => {
  const log = createMessageLog()
  for (let i = 0; i < 305; i++) log.add('a', 'b', `m${i}`, i)
  const all = log.all()
  expect(all).toHaveLength(300)
  expect(all[0].text).toBe('m5')
  expect(all.at(-1)).toEqual({ from: 'a', to: 'b', text: 'm304', at: 304 })
  expect(log.add('a', 'b', 'x'.repeat(5000)).text).toHaveLength(2001)
  // What it hands out is a copy, so nothing outside can change the log.
  log.all().length = 0
  expect(log.all()).toHaveLength(300)
})

test('with a file, messages are saved and come back after a restart, and a damaged file starts afresh', async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'pb-messages-'))
  try {
    const file = join(dir, 'messages.json')
    const log = createMessageLog(file)
    log.add('lead', 'dev', 'start on the parser', 1)
    log.add('dev', 'lead', 'done', 2)
    await log.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2)
    expect(createMessageLog(file).all().map((m) => m.text)).toEqual(['start on the parser', 'done'])
    writeFileSync(file, '{not json')
    expect(createMessageLog(file).all()).toEqual([])
    writeFileSync(file, JSON.stringify([{ from: 'a', to: 'b', text: 'ok', at: 1 }, { from: 'a', text: 'no to' }, 'junk']))
    expect(createMessageLog(file).all()).toEqual([{ from: 'a', to: 'b', text: 'ok', at: 1 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
