import { afterEach, expect, test, vi } from 'vitest'
import type { GitService } from '../../src/core/git/service'
import { registerWorkIpc } from '../../src/main/workIpc'
import { projectStore } from '../recipes/fakes'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) }, shell: {} }))

afterEach(() => handlers.clear())

// The git panel's and the board's channels, the only route that writes to GitHub among them, answer only the app's own
// window, as the rest of the app's IPC does (docs/improvement-log.md, W1).
test('pb:work:* answers the app window, and refuses any other sender before doing anything', async () => {
  const gh = vi.fn(async () => ({ code: 0, stdout: 'closed', stderr: '', truncated: false, timedOut: false }))
  const reader = { repoFor: vi.fn(async () => 'owner/repo') }
  const app = { fromApp: true }
  registerWorkIpc({ store: projectStore([], process.cwd()), startNode: async () => {}, git: {} as GitService, gh: gh as never, reader: reader as never, isAppUi: (e) => e === (app as never) })
  const close = handlers.get('pb:work:githubIssueAction')!

  await expect(Promise.resolve().then(() => close({ fromApp: false }, 'p1', 7, { kind: 'close' }))).rejects.toThrow(/Only the application UI/)
  expect(reader.repoFor).not.toHaveBeenCalled()
  expect(gh).not.toHaveBeenCalled()

  await expect(close(app, 'p1', 7, { kind: 'close' })).resolves.toEqual({ ok: true, output: 'closed' })
  expect(gh).toHaveBeenCalledTimes(1)
  // Every channel goes through the same check.
  for (const [name, fn] of handlers) {
    await expect(Promise.resolve().then(() => fn({ fromApp: false })), name).rejects.toThrow(/Only the application UI/)
  }
})
