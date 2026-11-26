import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { memoryStore } from '../control/fakes'
import { removeTemp } from '../support/realProcess'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined }, shell: { openPath: async () => '' } }))
const { findVsCode, openFolder, openInVsCodeAt } = await import('../../src/main/openFolder')

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }

test("VS Code is its Code.exe beside the bin folder its code.cmd is on PATH in; nothing else counts", () => {
  const files = new Set(['C:\\Tools\\VS Code\\bin\\code.cmd', 'C:\\Tools\\VS Code\\Code.exe', 'C:\\Other\\bin\\code.cmd'])
  const exists = (p: string) => files.has(p)
  expect(findVsCode({ PATH: 'C:\\Windows;C:\\Other\\bin;C:\\Tools\\VS Code\\bin' }, exists)).toBe('C:\\Tools\\VS Code\\Code.exe')
  // A code.cmd with no Code.exe above it (a different tool) is passed over.
  expect(findVsCode({ PATH: 'C:\\Other\\bin' }, exists)).toBeNull()
  expect(findVsCode({}, exists)).toBeNull()
})

test("a window's own folder opens in Explorer or VS Code, as one argument; no folder, a gone one or no VS Code says why", async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pb-open & 100% '))
  dirs.push(folder)
  const store = memoryStore([
    { ...box, id: 't', kind: 'terminal', title: 'T', cwd: folder },
    { ...box, id: 'gone', kind: 'terminal', title: 'G', cwd: join(folder, 'nope') },
    { ...box, id: 'n', kind: 'sticky', title: 'N', text: '' }
  ] as never)
  const opened: string[] = []
  const started: Array<[string, string]> = []
  const io = { openPath: async (p: string) => (opened.push(p), ''), vsCode: () => 'C:\\VS\\Code.exe', start: (exe: string, f: string) => void started.push([exe, f]) }

  expect(await openFolder(store, 't', 'explorer', io)).toEqual({ ok: true })
  expect(opened).toEqual([folder])
  expect(await openFolder(store, 't', 'vscode', io)).toEqual({ ok: true })
  expect(started).toEqual([['C:\\VS\\Code.exe', folder]])

  expect(await openFolder(store, 'n', 'explorer', io)).toEqual({ ok: false, reason: 'That window has no folder.' })
  expect(await openFolder(store, 'gone', 'explorer', io)).toEqual({ ok: false, reason: `${join(folder, 'nope')} isn't there any more.` })
  expect(await openFolder(store, 't', 'vscode', { ...io, vsCode: () => null })).toEqual({ ok: false, reason: "VS Code wasn't found: its `code` command isn't on PATH." })
  expect(await openFolder(store, 't', 'explorer', { ...io, openPath: async () => 'Access denied' })).toEqual({ ok: false, reason: 'Access denied' })
})

// F42: a file at a line, as Code.exe's own -g takes it, in one argument and with no shell.
test('a file opens at its line in VS Code with -g, or not at all when VS Code is not found', () => {
  const started: Array<{ exe: string; args: string[] }> = []
  const start = (exe: string, args: string[]) => void started.push({ exe, args })
  expect(openInVsCodeAt('C:/w/a & b.ts', 42, 7, { vsCode: () => 'C:/VS/Code.exe', start })).toBe(true)
  expect(openInVsCodeAt('C:/w/a.ts', 3, undefined, { vsCode: () => 'C:/VS/Code.exe', start })).toBe(true)
  expect(started).toEqual([
    { exe: 'C:/VS/Code.exe', args: ['-g', 'C:/w/a & b.ts:42:7'] },
    { exe: 'C:/VS/Code.exe', args: ['-g', 'C:/w/a.ts:3'] }
  ])
  expect(openInVsCodeAt('C:/w/a.ts', 3, undefined, { vsCode: () => null, start })).toBe(false)
  expect(openInVsCodeAt('C:/w/a.ts', 3, undefined, { vsCode: () => 'C:/VS/Code.exe', start: () => { throw new Error('gone') } })).toBe(false)
})
