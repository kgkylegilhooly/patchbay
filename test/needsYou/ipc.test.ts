import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CanvasDoc } from '../../src/shared/model'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))

const { registerNeedsYouIpc } = await import('../../src/main/needsYou/ipc')
const { peekSession } = await import('../../src/main/needsYou/peek')
const { createStatusTracker } = await import('../../src/main/sessions/statusTracker')

const calls = (id: string, name: string, input: unknown): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })

let dir = ''
afterEach(() => {
  handlers.clear()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('the peek channels', () => {
  test('answer only the app window', async () => {
    const tracker = createStatusTracker({ notify: () => {} })
    tracker.apply('a', { type: 'hook', name: 'PermissionRequest' })
    const doc = { nodes: [{ id: 'a', kind: 'claude', title: 'A', transcriptPath: null }] } as unknown as CanvasDoc
    const app = { app: true }
    registerNeedsYouIpc({ store: { get: () => doc, dispatch: () => {}, subscribe: () => () => {} }, tracker, isAppUi: (e) => e === (app as never) })
    expect(await handlers.get('pb:needsYou:peek')!({ other: true }, 'a')).toEqual({ ok: false, reason: expect.stringMatching(/only in the application UI/) })
    expect(await handlers.get('pb:needsYou:waits')!({ other: true })).toEqual({})
    expect(await handlers.get('pb:needsYou:peek')!(app, 'a')).toMatchObject({ ok: true })
    expect(Object.keys((await handlers.get('pb:needsYou:waits')!(app)) as object)).toEqual(['a'])
  })
})

describe('a call with a whole file in it', () => {
  test('is found with a wider read while the agent needs you', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-peek-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(file, calls('w', 'Write', { file_path: '/big.txt', content: 'x'.repeat(200 * 1024) }) + '\n')
    const doc = { nodes: [{ id: 'a', kind: 'claude', title: 'A', transcriptPath: file }] } as unknown as CanvasDoc
    const narrow = await peekSession({ doc: () => doc, since: () => undefined, status: () => 'working' }, 'a')
    expect(narrow.ok && narrow.peek.pending).toBeNull()
    const wide = await peekSession({ doc: () => doc, since: () => undefined, status: () => 'needs-you' }, 'a')
    expect(wide.ok && wide.peek.pending).toEqual({ tool: 'Write', summary: '/big.txt' })
  })
})
