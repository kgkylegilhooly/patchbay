import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { folderBytes, measureProjects, type FileInfo } from '../../src/main/projects/storage'
import type { CanvasDoc, CanvasNode, Project } from '../../src/shared/model'
import { removeTemp } from '../support/realProcess'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, folder: 'C:\\w', viewport: { x: 0, y: 0, zoom: 1 }, ...over }) as Project
const doc = (over: Partial<CanvasDoc>): CanvasDoc => ({ version: 3, projects: [], activeProjectId: 'a', nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 }, ...over }) as CanvasDoc

// What the Projects manager shows for each project: saved output, sessions running, and when it was last used.
test('a project adds up its sessions saved output, counts what runs, and takes its newest sign of use', async () => {
  const nodes = [
    { ...box, id: 't1', kind: 'terminal', title: 'T', cwd: 'C:\\w', projectId: 'b' },
    { ...box, id: 'c1', kind: 'claude', title: 'C', cwd: 'C:\\w', projectId: 'b', prompt: '', sessionId: 's', transcriptPath: 'C:\\t.jsonl', after: [] },
    { ...box, id: 'n1', kind: 'sticky', title: 'N', text: '', projectId: 'b' },
    { ...box, id: 't2', kind: 'terminal', title: 'T2', cwd: 'C:\\w', projectId: 'c' }
  ] as unknown as CanvasNode[]
  const files: Record<string, FileInfo> = { t1: { size: 1000, mtimeMs: 500 }, c1: { size: 24, mtimeMs: 400 }, 'C:\\t.jsonl': { size: 9, mtimeMs: 900 } }
  const stats = await measureProjects(
    doc({
      projects: [project('a'), project('b', { closedAt: 300 } as Partial<Project>), project('c', { archivedAt: 700 } as Partial<Project>), project('d')],
      activeProjectId: 'a',
      nodes,
      closed: [{ id: 'x', title: 'X', cwd: 'C:\\w', sessionId: 's2', transcriptPath: null, closedAt: 650, projectId: 'b' }]
    }),
    { scrollback: async (id) => files[id] ?? null, transcript: async (p) => files[p] ?? null, isRunning: (id) => id === 'c1', now: 10_000 }
  )
  const byId = Object.fromEntries(stats.map((s) => [s.id, s]))
  // On screen now is the newest sign of use.
  expect(byId.a).toEqual({ id: 'a', scrollbackBytes: 0, running: 0, lastActiveAt: 10_000 })
  // Output on disk adds up; the conversation, a closed session and closing the project all count as use; notes don't.
  expect(byId.b).toEqual({ id: 'b', scrollbackBytes: 1024, running: 1, lastActiveAt: 900 })
  expect(byId.c).toEqual({ id: 'c', scrollbackBytes: 0, running: 0, lastActiveAt: 700 })
  // Nothing to go on is said as such, not as some time.
  expect(byId.d).toEqual({ id: 'd', scrollbackBytes: 0, running: 0, lastActiveAt: null })
})

test('a folder adds up everything under it; one that is not there is nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-storage-'))
  dirs.push(root)
  mkdirSync(join(root, 'Cache', 'deep'), { recursive: true })
  writeFileSync(join(root, 'a.bin'), Buffer.alloc(100))
  writeFileSync(join(root, 'Cache', 'deep', 'b.bin'), Buffer.alloc(50))
  expect(await folderBytes(root)).toBe(150)
  expect(await folderBytes(join(root, 'missing'))).toBe(0)
})

test.runIf(process.platform === 'win32')('a linked folder inside is not counted or walked, so a link elsewhere cannot inflate or loop it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-storage-'))
  dirs.push(root)
  const big = join(root, 'elsewhere')
  const measured = join(root, 'partition')
  mkdirSync(big)
  mkdirSync(measured)
  writeFileSync(join(big, 'huge.bin'), Buffer.alloc(4000))
  writeFileSync(join(measured, 'own.bin'), Buffer.alloc(10))
  symlinkSync(big, join(measured, 'link'), 'junction')
  // And one that points back at itself.
  symlinkSync(measured, join(measured, 'loop'), 'junction')
  expect(await folderBytes(measured)).toBe(10)
})
