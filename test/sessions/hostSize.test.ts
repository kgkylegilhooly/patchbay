import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createSessionHost } from '../../src/main/sessions/host'

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>

function reportedSize(host: ReturnType<typeof createSessionHost>, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 15000)
    let seen = ''
    host.onOutput((from, data) => {
      if (from === id) seen += data
    })
    host.onExit((from) => {
      if (from !== id) return
      clearTimeout(timer)
      resolve(/size=(\d+x\d+)/.exec(seen)?.[1] ?? seen)
    })
    host.start({
      nodeId: id,
      file: process.execPath,
      args: ['-e', 'console.log(`size=${process.stdout.columns}x${process.stdout.rows}`)'],
      cwd: tmpdir(),
      env
    })
  })
}

test('a session starts at the size its window last asked for', async () => {
  const host = createSessionHost()
  host.resize('a', 100, 30)
  expect(await reportedSize(host, 'a')).toBe('100x30')
}, 20000)

test('a size from before a restart carries into the new session', async () => {
  const host = createSessionHost()
  host.resize('b', 90, 20)
  await reportedSize(host, 'b')
  expect(await reportedSize(host, 'b')).toBe('90x20')
}, 40000)

test('with no size asked for, a session starts at 80 by 24', async () => {
  expect(await reportedSize(createSessionHost(), 'c')).toBe('80x24')
}, 20000)
