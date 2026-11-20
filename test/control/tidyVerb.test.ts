import { expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, groupNode, memoryStore, terminalNode } from './fakes'

function setup(extra: CanvasNode[]) {
  const store = memoryStore([claudeNode('me', { x: 0, y: 0 }), ...extra])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate, timing: { enterDelayMs: 0, settleMs: 0 } })
  const node = (id: string) => store.get().nodes.find((n) => n.id === id)!
  return { store, tracker, verbs, node }
}

const overlapping = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('arrange --layout tidy lays out the whole project with nothing on top of anything', async () => {
  const { verbs, store } = setup([terminalNode('a', { x: 0, y: 0 }), terminalNode('b', { x: 5, y: 5 }), claudeNode('w', { x: 10, y: 10, openedBy: 'me' })])
  const result = await verbs('me', 'arrange', { layout: 'tidy' })
  expect(result).toMatchObject({ arranged: 4 })
  const tops = store.get().nodes
  for (const a of tops) for (const b of tops) if (a.id < b.id) expect(overlapping(a, b), `${a.id} ${b.id}`).toBe(false)
  // Run again: already tidy.
  expect(await verbs('me', 'arrange', { layout: 'tidy' })).toMatchObject({ moved: 0 })
})

test('arrange --layout tidy --status puts the agent that needs you first', async () => {
  const { verbs, tracker, node } = setup([claudeNode('later', { x: 700, y: 0 }), claudeNode('urgent', { x: 1400, y: 0 })])
  tracker.seed('me', 'idle')
  tracker.seed('later', 'idle')
  tracker.seed('urgent', 'needs-you')
  await verbs('me', 'arrange', { layout: 'tidy', status: true })
  const order = ['me', 'later', 'urgent'].sort((a, b) => node(a).y - node(b).y || node(a).x - node(b).x)
  expect(order).toEqual(['urgent', 'me', 'later'])
})

test('arrange --layout tidy --group tidies inside the group, and refuses a node that is not a group', async () => {
  const { verbs, node } = setup([
    groupNode('g', { x: 2000, y: 0, width: 1000, height: 1000 }),
    terminalNode('m1', { parentId: 'g', x: 24, y: 64 }),
    terminalNode('m2', { parentId: 'g', x: 30, y: 70 })
  ])
  await verbs('me', 'arrange', { layout: 'tidy', group: 'g' })
  expect(overlapping(node('m1'), node('m2'))).toBe(false)
  expect(node('m1').parentId).toBe('g')
  expect(node('me')).toMatchObject({ x: 0, y: 0 })
  const err = await verbs('me', 'arrange', { layout: 'tidy', group: 'm1' }).catch((e) => e)
  expect(err).toBeInstanceOf(RpcRefusal)
})

test('the existing layouts are unchanged', async () => {
  const { verbs, node } = setup([terminalNode('a'), terminalNode('b')])
  await verbs('me', 'arrange', { ids: ['a', 'b'], layout: 'column', gap: 10 })
  expect(node('b').y).toBe(node('a').y + node('a').height + 10)
  expect(node('b').x).toBe(node('a').x)
})
