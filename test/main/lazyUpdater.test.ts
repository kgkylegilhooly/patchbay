import { expect, test, vi } from 'vitest'
import { lazyUpdater } from '../../src/main/lazyUpdater'
import { createUpdates, type Updater } from '../../src/main/updates'

function fakeUpdater() {
  const handlers: Record<string, Array<(arg: never) => void>> = {}
  const u = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => {
      for (const cb of handlers['update-not-available'] ?? []) cb(undefined as never)
    }),
    quitAndInstall: vi.fn(),
    on: (event: string, cb: (arg: never) => void) => ((handlers[event] ??= []).push(cb), u)
  }
  return u
}

test('nothing is loaded at start-up, however it is set up', () => {
  const load = vi.fn(() => fakeUpdater() as unknown as Updater)
  createUpdates({ updater: lazyUpdater(load), feed: () => 'github:a/b', packaged: true })
  expect(load).not.toHaveBeenCalled()
})

test('the first check loads it, with the settings and listeners given before', async () => {
  const real = fakeUpdater()
  const load = vi.fn(() => real as unknown as Updater)
  const updates = createUpdates({ updater: lazyUpdater(load), feed: () => 'github:a/b', packaged: true, now: () => 7 })
  await updates.check()
  expect(load).toHaveBeenCalledTimes(1)
  expect(real.autoDownload).toBe(true)
  expect(real.autoInstallOnAppQuit).toBe(false)
  expect(real.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'a', repo: 'b' })
  // Its events reach the state, as they did when it was loaded at start-up.
  expect(updates.state()).toEqual({ phase: 'none', checkedAt: 7 })
  await updates.check()
  expect(load).toHaveBeenCalledTimes(1)
})

test('a dev copy never loads it', async () => {
  const load = vi.fn(() => fakeUpdater() as unknown as Updater)
  const updates = createUpdates({ updater: lazyUpdater(load), feed: () => 'github:a/b', packaged: false })
  await updates.check()
  expect(load).not.toHaveBeenCalled()
  expect(updates.state().phase).toBe('off')
})

test('settings given after it loaded go straight to it', () => {
  const real = fakeUpdater()
  const lazy = lazyUpdater(() => real as unknown as Updater)
  lazy.setFeedURL({ provider: 'generic', url: 'https://x/' })
  lazy.autoDownload = true
  expect(real.autoDownload).toBe(true)
  expect(lazy.autoDownload).toBe(true)
})
