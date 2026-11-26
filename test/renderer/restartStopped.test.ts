import { expect, test, vi } from 'vitest'
import { nodeMenu, type Commands, type MenuItem } from '../../src/renderer/menus'
import { stoppedIn } from '../../src/renderer/restartStopped'
import type { CanvasNode } from '../../src/shared/model'

const box = { x: 0, y: 0, width: 400, height: 300, parentId: null as string | null, projectId: 'p' }
const group = (id: string, parentId: string | null = null): CanvasNode => ({ ...box, id, title: id, kind: 'group', worktree: null, parentId }) as CanvasNode
const agent = (id: string, parentId: string): CanvasNode => ({ ...box, id, title: id, kind: 'claude', cwd: 'C:\\a', sessionId: null, transcriptPath: null, after: [], parentId })
const shell = (id: string, parentId: string): CanvasNode => ({ ...box, id, title: id, kind: 'terminal', cwd: 'C:\\a', parentId })
const run = (id: string, parentId: string): CanvasNode => ({ ...box, id, title: id, kind: 'run', cwd: 'C:\\a', command: 'npm test', parentId }) as CanvasNode

test('the exited or failed windows in a group, at any depth; not runs, and not one only waiting for memory', () => {
  const nodes = [group('g'), group('inner', 'g'), agent('a', 'g'), agent('b', 'inner'), shell('c', 'g'), agent('d', 'g'), run('r', 'g'), agent('m', 'g'), agent('out', 'other')]
  const statuses = { a: 'exited', b: 'exited', c: 'exited', d: 'idle', r: 'exited', m: 'exited', out: 'exited' } as const
  const errors = { m: { code: 'spawn-failed' as const, message: 'Waiting for memory', fix: 'memory' as const }, c: { code: 'cwd-missing' as const, message: 'No such folder', fix: 'folder' as const } }
  expect(stoppedIn(nodes, 'g', statuses, errors)).toEqual(['a', 'b', 'c'])
  // A start that failed counts even before any status.
  expect(stoppedIn([group('g'), agent('x', 'g')], 'g', {}, { x: { code: 'spawn-failed', message: 'Agent is off', fix: 'agents' } })).toEqual(['x'])
})

test('a group with stopped windows offers Restart N stopped windows in its menu', () => {
  const restarted: string[][] = []
  const c = new Proxy({} as Commands, { get: (_t, key) => (key === 'restartNodes' ? (ids: string[]) => restarted.push(ids) : vi.fn()) })
  const items = (stopped: string[]) => nodeMenu(c, group('g'), null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false, stopped }).filter((e): e is MenuItem => e !== 'separator')
  const item = items(['a', 'b']).find((i) => i.id === 'restart-stopped')
  expect(item?.label).toBe('Restart 2 stopped windows')
  item!.run()
  expect(restarted).toEqual([['a', 'b']])
  expect(items(['a']).find((i) => i.id === 'restart-stopped')?.label).toBe('Restart 1 stopped window')
  expect(items([]).find((i) => i.id === 'restart-stopped')).toBeUndefined()
})
