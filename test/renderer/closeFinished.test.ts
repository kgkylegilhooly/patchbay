import { expect, test } from 'vitest'
import { closeFinishedAgents, finishedIn, finishedPlan } from '../../src/renderer/closeFinished'
import type { CanvasNode } from '../../src/shared/model'

// F60: after a team run, the idle agents a group holds close in one step. One that left its own edits uncommitted stays.
const box = { x: 0, y: 0, width: 10, height: 10 }
const group = { ...box, id: 'g', kind: 'group', title: 'Team', parentId: null, worktree: null } as CanvasNode
const agent = (id: string, parentId: string | null = 'g') => ({ ...box, id, kind: 'claude', title: `Agent ${id}`, cwd: 'C:/w', sessionId: 's', transcriptPath: null, after: [], parentId }) as CanvasNode
const term = { ...box, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:/w', parentId: 'g' } as CanvasNode

test('finished means an idle agent inside the group, at any depth; working, waiting on you and terminals are not', () => {
  const inner = { ...group, id: 'g2', parentId: 'g' } as CanvasNode
  const nodes = [group, inner, agent('a'), agent('b'), agent('c'), { ...agent('d'), parentId: 'g2' } as CanvasNode, agent('out', null), term]
  const statuses = { a: 'idle', b: 'working', c: 'needs-you', d: 'idle', out: 'idle', t: 'idle' } as const
  expect(finishedIn(nodes, 'g', statuses).map((n) => n.id)).toEqual(['a', 'd'])
})

test('the plan closes the ones with nothing of their own uncommitted and names the rest', () => {
  const plan = finishedPlan([
    { id: 'a', title: 'Parser', files: [] },
    { id: 'b', title: 'Docs', files: ['README.md', 'docs/a.md'] },
    { id: 'c', title: 'Tests', files: [] }
  ])
  expect(plan.close.map((a) => a.id)).toEqual(['a', 'c'])
  expect(plan.message).toBe('Closes Parser and Tests. Closed conversations can reopen each. Docs stays open: it left 2 files it edited uncommitted.')
  expect(finishedPlan([{ id: 'b', title: 'Docs', files: ['x'] }]).close).toEqual([])
})

test('closing asks first, then closes only those; a check that fails or is slow closes nothing', async () => {
  const closed: string[][] = []
  const asked: string[] = []
  const ask = async (message: string, run: () => void) => {
    asked.push(message)
    run()
  }
  const agents = [
    { id: 'a', title: 'Parser' },
    { id: 'b', title: 'Docs' }
  ]
  await closeFinishedAgents(agents, { uncommitted: async (id) => (id === 'b' ? ['x.md'] : []) }, (ids) => closed.push(ids), ask)
  expect(closed).toEqual([['a']])
  expect(asked[0]).toMatch(/^Closes Parser\. .*Docs stays open/)

  const said: string[] = []
  await closeFinishedAgents(agents, { uncommitted: async () => Promise.reject(new Error('no git')) }, (ids) => closed.push(ids), ask, (t) => said.push(t))
  await closeFinishedAgents(agents, { uncommitted: () => new Promise(() => {}) }, (ids) => closed.push(ids), ask, (t) => said.push(t), 20)
  expect(closed).toHaveLength(1)
  expect(said).toEqual([
    "Couldn't check what these agents left uncommitted, so none was closed.",
    "Couldn't check what these agents left uncommitted, so none was closed."
  ])
})

test('a group with idle agents offers Close N finished agents, which hands them over for the check', async () => {
  const { nodeMenu } = await import('../../src/renderer/menus')
  const asked: Array<Array<{ id: string; title: string }>> = []
  const c = new Proxy({} as import('../../src/renderer/menus').Commands, { get: (_t, key) => (key === 'closeFinished' ? (a: Array<{ id: string; title: string }>) => asked.push(a) : () => {}) })
  const items = (finished: Array<{ id: string; title: string }>) =>
    nodeMenu(c, group, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false, finished }).filter((e): e is import('../../src/renderer/menus').MenuItem => e !== 'separator')
  const two = [
    { id: 'a', title: 'Parser' },
    { id: 'b', title: 'Docs' }
  ]
  const item = items(two).find((i) => i.id === 'close-finished')
  expect(item?.label).toBe('Close 2 finished agents…')
  item!.run()
  expect(asked).toEqual([two])
  expect(items([two[0]]).find((i) => i.id === 'close-finished')?.label).toBe('Close 1 finished agent…')
  expect(items([]).find((i) => i.id === 'close-finished')).toBeUndefined()
})
