import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { createUpdates, parseFeed, type Updater } from '../../src/main/updates'

test.each([
  ['github:acme/patchbay', { provider: 'github', owner: 'acme', repo: 'patchbay' }],
  ['https://updates.example.com/patchbay', { provider: 'generic', url: 'https://updates.example.com/patchbay/' }],
  ['http://127.0.0.1:8080/feed/', { provider: 'generic', url: 'http://127.0.0.1:8080/feed/' }]
])('the feed %s is understood', (text, feed) => {
  expect(parseFeed(text)).toEqual(feed)
})

test.each(['', '   ', 'http://updates.example.com/', 'ftp://x/', 'github:acme', 'file:///C:/feed', 'nonsense'])('the feed "%s" is refused', (text) => {
  expect(parseFeed(text)).toBeNull()
})

function fake(onCheck: (u: EventEmitter) => void = () => {}) {
  const em = new EventEmitter()
  const calls: string[] = []
  const updater = Object.assign(em, {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    setFeedURL: (f: unknown) => calls.push(`feed ${JSON.stringify(f)}`),
    checkForUpdates: async () => {
      calls.push('check')
      onCheck(em)
    },
    quitAndInstall: (silent?: boolean, run?: boolean) => calls.push(`install ${silent} ${run}`)
  })
  return { updater: updater as unknown as Updater & EventEmitter, calls }
}

test('downloads start by themselves, and nothing installs on quit without Restart to update', () => {
  const { updater } = fake()
  createUpdates({ updater, feed: () => 'github:a/b', packaged: true })
  expect(updater.autoDownload).toBe(true)
  expect(updater.autoInstallOnAppQuit).toBe(false)
})

test('a check that finds a version follows it through download to ready, and install restarts into it', async () => {
  const { updater, calls } = fake((u) => {
    u.emit('checking-for-update')
    u.emit('update-available', { version: '0.2.0' })
    u.emit('download-progress', { percent: 41.6 })
  })
  const seen: string[] = []
  const updates = createUpdates({ updater, feed: () => 'github:a/b', packaged: true })
  updates.onChange((s) => seen.push(s.phase === 'downloading' ? `downloading ${s.percent}` : s.phase))
  await updates.check()
  expect(calls[0]).toBe('feed {"provider":"github","owner":"a","repo":"b"}')
  expect(seen).toEqual(['checking', 'downloading 0', 'downloading 42'])
  updater.emit('update-downloaded', { version: '0.2.0' })
  expect(updates.state()).toEqual({ phase: 'ready', version: '0.2.0' })
  expect(updates.ready()).toBe(true)
  // While one is waiting, another check doesn't start over.
  await updates.check()
  expect(calls.filter((c) => c === 'check')).toHaveLength(1)
  updates.install()
  expect(calls.at(-1)).toBe('install true true')
})

test('no feed, a bad feed, or a development run says why, without asking anyone', async () => {
  const { updater, calls } = fake()
  expect((await run(createUpdates({ updater, feed: () => '', packaged: true }))).state()).toEqual({ phase: 'off', reason: 'No update feed is set.' })
  expect((await run(createUpdates({ updater, feed: () => 'github:x', packaged: true }))).state()).toEqual({ phase: 'off', reason: "That update feed isn't valid." })
  expect((await run(createUpdates({ updater, feed: () => 'github:a/b', packaged: false }))).state().phase).toBe('off')
  expect(calls).toEqual([])
})

test('an error says what went wrong, in one line', async () => {
  const { updater } = fake(() => {
    throw new Error('net::ERR_NAME_NOT_RESOLVED\n    at stack')
  })
  const updates = await run(createUpdates({ updater, feed: () => 'github:a/b', packaged: true }))
  expect(updates.state()).toEqual({ phase: 'error', message: 'net::ERR_NAME_NOT_RESOLVED' })
})

test('up to date says when it was checked', async () => {
  const { updater } = fake((u) => u.emit('update-not-available', {}))
  const updates = await run(createUpdates({ updater, feed: () => 'github:a/b', packaged: true, now: () => 1234 }))
  expect(updates.state()).toEqual({ phase: 'none', checkedAt: 1234 })
})

async function run(u: ReturnType<typeof createUpdates>) {
  await u.check()
  return u
}
