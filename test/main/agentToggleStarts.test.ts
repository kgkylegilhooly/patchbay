import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readAgentsFrom } from '../../src/main/agentsAllowed'
import { createSearchService } from '../../src/main/search/service'
import { registerWorkIpc } from '../../src/main/workIpc'
import type { GitService } from '../../src/core/git/service'
import { projectStore } from '../recipes/fakes'

/** The issue start's IPC handler, caught as registerWorkIpc registers it. */
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) }, shell: {} }))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay agent starts '))
})
afterEach(() => {
  readAgentsFrom(() => ({}))
  handlers.clear()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('starting work on an issue is refused while Claude Code is off, before any worktree, group or node is made', async () => {
  readAgentsFrom(() => ({ agentsOff: 'claude' }))
  const store = projectStore([], dir)
  const started: string[] = []
  const toplevel = vi.fn(async () => dir)
  registerWorkIpc({ store, startNode: async (id) => void started.push(id), git: { toplevel } as unknown as GitService, gh: {} as never, reader: {} as never, isAppUi: () => true })
  const start = handlers.get('pb:work:startIssueAgent')!
  const r = await start({}, { projectId: 'p1', number: 7, prompt: 'Fix #7', title: '#7 Fix', worktreeBranch: 'fix-7' })
  expect(r).toEqual({ ok: false, error: expect.stringMatching(/^Claude Code is turned off in Settings > Agents.*Patchbay may use Codex\./) })
  expect(toplevel).not.toHaveBeenCalled()
  expect(store.get().nodes).toEqual([])
  expect(started).toEqual([])
})

test('a handoff to an agent that is off is refused and adds nothing; the other agent still starts', async () => {
  readAgentsFrom(() => ({ agentsOff: 'codex' }))
  const store = projectStore([], dir)
  const started: string[] = []
  const service = createSearchService({
    store,
    messages: () => [],
    status: () => undefined,
    gitChanges: async () => ({ unavailable: 'none' }),
    startNode: async (id) => void started.push(id),
    backend: (async () => ({})) as never
  })
  const refused = await service.startHandoff({ text: 'Continue the export', agent: 'codex', cwd: dir, title: 'Continue' })
  expect(refused).toEqual({ ok: false, reason: expect.stringMatching(/^Codex is turned off in Settings > Agents/) })
  expect(store.get().nodes).toEqual([])
  expect(started).toEqual([])
  const ok = await service.startHandoff({ text: 'Continue the export', agent: 'claude', cwd: dir, title: 'Continue' })
  expect(ok).toMatchObject({ ok: true })
  expect(started).toHaveLength(1)
})
