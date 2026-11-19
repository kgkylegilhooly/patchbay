import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { absoluteRect } from '../../src/core/canvas/place'
import type { CanvasNode } from '../../src/shared/model'
import type { StickyNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, groupNode, memoryStore } from './fakes'

const stickyNode = (id: string, over: Partial<StickyNode> = {}): StickyNode => ({ id, kind: 'sticky', title: id, text: '', x: 0, y: 0, width: 280, height: 220, parentId: null, ...over })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay placement '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(nodes: CanvasNode[]) {
  const store = memoryStore(nodes)
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate, timing: { enterDelayMs: 0, settleMs: 0 } })
  const node = (id: string) => store.get().nodes.find((n) => n.id === id)!
  const tops = () => store.get().nodes.filter((n) => !n.parentId)
  return { store, verbs, node, tops }
}

const covers = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const id = (r: unknown) => (r as { id: string }).id

/** The report: the lead at the top left, a tall group of four agents in a 2x2 grid right beside it. */
function reported(): CanvasNode[] {
  return [
    claudeNode('lead', { cwd: dir, x: 0, y: 0, width: 620, height: 420 }),
    groupNode('team', { x: 660, y: 0, width: 1328, height: 968 }),
    claudeNode('a', { cwd: dir, x: 24, y: 64, width: 620, height: 420, parentId: 'team' }),
    claudeNode('b', { cwd: dir, x: 684, y: 64, width: 620, height: 420, parentId: 'team' }),
    claudeNode('c', { cwd: dir, x: 24, y: 524, width: 620, height: 420, parentId: 'team' }),
    claudeNode('d', { cwd: dir, x: 684, y: 524, width: 620, height: 420, parentId: 'team' })
  ]
}

test("the report: the lead's sticky lands next to the lead, not under the tall group", async () => {
  const { verbs, node, tops } = setup(reported())
  const note = node(id(await verbs('lead', 'sticky', { text: 'Plan' })))
  const lead = node('lead')
  const team = node('team')
  // It used to land at y 1008, below the whole group.
  expect(note.y).toBeLessThan(team.y + team.height)
  expect(note).toMatchObject({ x: 0, y: lead.y + lead.height + 40 })
  for (const other of tops()) if (other.id !== note.id) expect(covers(note, other)).toBe(false)
})

test('an agent opened by a group member goes just outside its group, level with the member', async () => {
  const { verbs, node, tops } = setup(reported())
  const helper = node(id(await verbs('b', 'open-agent', { prompt: 'help' })))
  const team = node('team')
  expect(helper.parentId).toBeNull()
  expect(helper.x).toBe(team.x + team.width + 40)
  expect(helper.y).toBe(absoluteRect({ nodes: [node('team'), node('b')] }, node('b')).y)
  for (const other of tops()) if (other.id !== helper.id) expect(covers(helper, other)).toBe(false)
})

test('nodes opened into a group fill a two-wide grid, and the group grows to hold them', async () => {
  const { verbs, node, store } = setup([claudeNode('lead', { cwd: dir, x: 0, y: 0, width: 620, height: 420 }), groupNode('g', { x: 700, y: 0, width: 640, height: 400 })])
  const ids: string[] = []
  for (let i = 0; i < 3; i++) ids.push(id(await verbs('lead', 'open-terminal', { group: 'g' })))
  const at = ids.map((n) => ({ x: node(n).x, y: node(n).y }))
  expect(at).toEqual([
    { x: 24, y: 64 },
    { x: 24 + 560 + 40, y: 64 },
    { x: 24, y: 64 + 340 + 40 }
  ])
  const g = node('g')
  for (const n of ids) {
    expect(node(n).parentId).toBe('g')
    expect(node(n).x + node(n).width).toBeLessThanOrEqual(g.width)
    expect(node(n).y + node(n).height).toBeLessThanOrEqual(g.height)
  }
  // The lead stays where it was.
  expect(store.get().nodes.find((n) => n.id === 'lead')).toMatchObject({ x: 0, y: 0 })
})

test("spawn-team finds room for the whole team's row, so the group covers nothing", async () => {
  // Something sits a little to the lead's right, where a default-size group would have fit but a team row doesn't.
  const { verbs, node, tops } = setup([claudeNode('lead', { cwd: dir, x: 0, y: 0, width: 620, height: 420 }), stickyNode('note', { x: 1400, y: 0 })])
  const r = (await verbs('lead', 'spawn-team', { label: 'T', members: [{ name: 'one' }, { name: 'two' }, { name: 'three' }] })) as { group: string }
  const g = node(r.group)
  expect(g.width).toBe(2 * 24 + 3 * 620 + 2 * 40)
  for (const other of tops()) if (other.id !== g.id) expect(covers(g, other)).toBe(false)
})

test("a node in another project doesn't push a new one away", async () => {
  const { verbs, node } = setup([
    claudeNode('lead', { cwd: dir, x: 0, y: 0, width: 620, height: 420, projectId: 'p1' }),
    stickyNode('theirs', { x: 660, y: 0, projectId: 'p2' })
  ])
  const note = node(id(await verbs('lead', 'sticky', { text: 'x' })))
  expect(note).toMatchObject({ x: 660, y: 0, projectId: 'p1' })
})
