import { describe, expect, test } from 'vitest'
import { absoluteRect, GROUP_PAD, GROUP_TOP, PLACE_GAP, type Rect } from '../../src/core/canvas/place'
import { reduce } from '../../src/core/canvas/reduce'
import { boundsOf, panToShow, planTidy, tidyOp, tidyResult, type TidyOptions } from '../../src/core/canvas/tidy'
import { entryFor } from '../../src/renderer/undoHistory'
import type { AgentStatus, CanvasDoc, CanvasNode, Edge } from '../../src/shared/model'

const AGENT = { width: 620, height: 420 }
const NOTE = { width: 280, height: 220 }

function node(id: string, extra: Partial<CanvasNode> & { x: number; y: number }): CanvasNode {
  return { id, kind: 'sticky', title: id, text: '', parentId: null, projectId: 'p1', ...AGENT, ...extra } as CanvasNode
}
const agent = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  node(id, { kind: 'claude', x, y, ...extra } as Partial<CanvasNode> & { x: number; y: number })
const group = (id: string, x: number, y: number, width: number, height: number): CanvasNode =>
  node(id, { kind: 'group', x, y, width, height, worktree: null } as Partial<CanvasNode> & { x: number; y: number })
const edge = (from: string, to: string, kind: Edge['kind'] = 'opened'): Edge => ({ id: `${from}-${to}-${kind}`, from, to, kind })

function docOf(nodes: CanvasNode[], edges: Edge[] = []): CanvasDoc {
  return {
    version: 3,
    projects: [{ id: 'p1', name: 'One', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    nodes,
    edges,
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

const VIEW: Rect = { x: 0, y: 0, width: 2400, height: 1400 }
const opts = (over: Partial<TidyOptions> = {}): TidyOptions => ({ projectId: 'p1', scope: { kind: 'project' }, view: VIEW, ...over })

function tidy(doc: CanvasDoc, over: Partial<TidyOptions> = {}): CanvasDoc {
  const plan = planTidy(doc, opts(over))
  return plan ? reduce(doc, tidyOp(plan)) : doc
}

const rectOf = (doc: CanvasDoc, id: string): Rect => absoluteRect(doc, doc.nodes.find((n) => n.id === id)!)
const covers = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

function expectNoOverlap(doc: CanvasDoc, parentId: string | null, gap = PLACE_GAP): void {
  const rects = doc.nodes.filter((n) => (n.parentId ?? null) === parentId).map((n) => ({ id: n.id, r: rectOf(doc, n.id) }))
  for (const a of rects)
    for (const b of rects) {
      if (a.id >= b.id) continue
      const grown = { x: a.r.x - gap + 1, y: a.r.y - gap + 1, width: a.r.width + 2 * gap - 2, height: a.r.height + 2 * gap - 2 }
      expect(covers(grown, b.r), `${a.id} and ${b.id} are closer than the gap`).toBe(false)
    }
}

/** Stacked and scattered: half the nodes on top of each other, a group with two members, a lead with three workers. */
function messy(): CanvasDoc {
  return docOf(
    [
      agent('lead', 900, 900),
      agent('w1', 0, 0, { openedBy: 'lead' }),
      agent('w2', 10, 10, { openedBy: 'lead' }),
      agent('w3', 20, 20, { openedBy: 'lead' }),
      node('note', { x: 30, y: 30, ...NOTE }),
      agent('solo', 2000, -500),
      group('g', 400, 300, 2 * GROUP_PAD + AGENT.width, GROUP_TOP + 2 * AGENT.height + PLACE_GAP + GROUP_PAD),
      agent('g1', GROUP_PAD, GROUP_TOP, { parentId: 'g' }),
      agent('g2', GROUP_PAD, GROUP_TOP + AGENT.height + PLACE_GAP, { parentId: 'g' }),
      node('trig', { kind: 'trigger', x: 50, y: 50, width: 300, height: 160, targetId: 'solo' } as Partial<CanvasNode> & { x: number; y: number })
    ],
    [edge('g1', 'note', 'link')]
  )
}

describe('tidy the whole project', () => {
  test('nothing overlaps or comes within the gap afterwards', () => {
    expectNoOverlap(tidy(messy()), null)
  })

  test('a group moves as one block: its members keep their places inside it and its size', () => {
    const before = messy()
    const after = tidy(before)
    for (const id of ['g', 'g1', 'g2']) {
      const n = before.nodes.find((x) => x.id === id)!
      const m = after.nodes.find((x) => x.id === id)!
      expect([m.width, m.height]).toEqual([n.width, n.height])
      if (id !== 'g') expect([m.x, m.y]).toEqual([n.x, n.y])
    }
    expect(inside(rectOf(after, 'g1'), rectOf(after, 'g'))).toBe(true)
  })

  test('starts where the tidied nodes started, so the view stays on them', () => {
    const before = messy()
    const tops = before.nodes.filter((n) => !n.parentId)
    const after = tidy(before)
    const b = boundsOf(after.nodes.filter((n) => !n.parentId).map((n) => rectOf(after, n.id)))!
    expect([b.x, b.y]).toEqual([Math.min(...tops.map((n) => n.x)), Math.min(...tops.map((n) => n.y))])
  })

  test('only moves nodes in the project being tidied', () => {
    const doc = messy()
    doc.projects.push({ id: 'p2', name: 'Two', folder: '', viewport: { x: 0, y: 0, zoom: 1 } })
    doc.nodes.push(agent('other', 5, 5, { projectId: 'p2' }))
    expect(tidy(doc).nodes.find((n) => n.id === 'other')).toMatchObject({ x: 5, y: 5 })
  })
})

describe('related nodes stay together', () => {
  test('a lead sits to the left of the team it opened, and the team sits together', () => {
    const after = tidy(messy())
    const lead = rectOf(after, 'lead')
    const team = ['w1', 'w2', 'w3'].map((id) => rectOf(after, id))
    for (const w of team) expect(w.x).toBe(lead.x + lead.width + PLACE_GAP)
    expect(team[0].y).toBe(lead.y)
    // Nothing else is drawn in among them.
    const block = boundsOf([lead, ...team])!
    for (const n of after.nodes.filter((x) => !x.parentId && !['lead', 'w1', 'w2', 'w3'].includes(x.id))) {
      expect(covers(block, rectOf(after, n.id)), n.id).toBe(false)
    }
  })

  test('a trigger sits just left of its target, level with it', () => {
    const after = tidy(messy())
    const trig = rectOf(after, 'trig')
    const target = rectOf(after, 'solo')
    expect(target.x).toBe(trig.x + trig.width + PLACE_GAP)
    expect(target.y).toBe(trig.y)
  })

  test("a note cabled to a node in a group sits beside that group", () => {
    const after = tidy(messy())
    const g = rectOf(after, 'g')
    const note = rectOf(after, 'note')
    expect(note.x).toBe(g.x + g.width + PLACE_GAP)
    expect(note.y).toBe(g.y)
  })

  test('a big team is a grid beside its lead, not one long column', () => {
    const workers = Array.from({ length: 9 }, (_, i) => agent(`w${i}`, i * 30, i * 30, { openedBy: 'lead' }))
    const after = tidy(docOf([agent('lead', 0, 0), ...workers]))
    const xs = new Set(workers.map((w) => rectOf(after, w.id).x))
    const ys = new Set(workers.map((w) => rectOf(after, w.id).y))
    expect([xs.size, ys.size]).toEqual([3, 3])
    expectNoOverlap(after, null)
  })

  test('a chain of after-cables reads left to right', () => {
    const after = tidy(docOf([agent('c', 0, 0), agent('a', 0, 500), agent('b', 0, 1000)], [edge('a', 'b', 'after'), edge('b', 'c', 'after')]))
    const [a, b, c] = ['a', 'b', 'c'].map((id) => rectOf(after, id))
    expect(a.x < b.x && b.x < c.x).toBe(true)
    expect(new Set([a.y, b.y, c.y]).size).toBe(1)
  })

  test('a loop of cables still places every node once', () => {
    const after = tidy(docOf([agent('a', 0, 0), agent('b', 0, 0), agent('c', 0, 0)], [edge('a', 'b', 'link'), edge('b', 'c', 'link'), edge('c', 'a', 'link')]))
    expectNoOverlap(after, null)
  })
})

describe('needs you first', () => {
  const statuses: Record<string, AgentStatus> = { a: 'idle', b: 'exited', c: 'working', d: 'needs-you' }
  const doc = (): CanvasDoc => docOf([agent('a', 0, 0), agent('b', 700, 0), agent('c', 1400, 0), agent('d', 2100, 0), node('n', { x: 0, y: 500, ...NOTE })])
  const order = (after: CanvasDoc): string[] =>
    after.nodes
      .filter((n) => !n.parentId)
      .map((n) => ({ id: n.id, r: rectOf(after, n.id) }))
      .sort((p, q) => p.r.y - q.r.y || p.r.x - q.r.x)
      .map((p) => p.id)

  test('puts the agent that needs you top left, then working, then idle and ended, then the rest', () => {
    expect(order(tidy(doc(), { byStatus: true, statuses }))).toEqual(['d', 'c', 'a', 'b', 'n'])
  })

  test('without it, order is the order they were made', () => {
    expect(order(tidy(doc(), { statuses }))).toEqual(['a', 'b', 'c', 'd', 'n'])
  })

  test('a group counts as its most urgent member, and its team comes with the lead', () => {
    const d = docOf(
      [agent('x', 0, 0), group('g', 0, 600, 700, 600), agent('m', GROUP_PAD, GROUP_TOP, { parentId: 'g' }), agent('lead', 1400, 0), agent('w', 2100, 0, { openedBy: 'lead' })]
    )
    const after = tidy(d, { byStatus: true, statuses: { x: 'idle', m: 'needs-you', lead: 'idle', w: 'working' } })
    expect(order(after).slice(0, 3)).toEqual(['g', 'lead', 'w'])
  })
})

describe('tidy a group', () => {
  const crowded = (): CanvasDoc =>
    docOf([
      group('g', 0, 0, 800, 600),
      agent('a', GROUP_PAD, GROUP_TOP, { parentId: 'g' }),
      agent('b', GROUP_PAD + 5, GROUP_TOP + 5, { parentId: 'g' }),
      agent('c', GROUP_PAD + 10, GROUP_TOP + 10, { parentId: 'g' }),
      agent('d', GROUP_PAD + 15, GROUP_TOP + 15, { parentId: 'g' }),
      agent('outside', 3000, 0)
    ])

  test('lays the members out as a grid inside the group and fits the group round them', () => {
    const after = tidy(crowded(), { scope: { kind: 'group', id: 'g' } })
    expectNoOverlap(after, 'g')
    const g = rectOf(after, 'g')
    for (const id of ['a', 'b', 'c', 'd']) expect(inside(rectOf(after, id), g)).toBe(true)
    expect(after.nodes.find((n) => n.id === 'a')).toMatchObject({ x: GROUP_PAD, y: GROUP_TOP })
    expect(g.width).toBe(2 * GROUP_PAD + 2 * AGENT.width + PLACE_GAP)
    expect(g.height).toBe(GROUP_TOP + 2 * AGENT.height + PLACE_GAP + GROUP_PAD)
    expect(rectOf(after, 'outside')).toMatchObject({ x: 3000, y: 0 })
  })

  test('selecting just the group tidies its members', () => {
    const plan = planTidy(crowded(), opts({ scope: { kind: 'selection', ids: ['g'] } }))!
    expect(plan.scope).toEqual({ kind: 'group', id: 'g' })
    expect(plan.parentId).toBe('g')
  })

  test('a group that would grow into its neighbour moves clear of it instead', () => {
    const doc = crowded()
    doc.nodes.find((n) => n.id === 'outside')!.x = 900
    const after = tidy(doc, { scope: { kind: 'group', id: 'g' } })
    expectNoOverlap(after, null)
    expect(rectOf(after, 'outside')).toMatchObject({ x: 900, y: 0 })
  })
})

describe('tidy the selection', () => {
  test('moves only what is selected, and keeps it clear of everything else', () => {
    const doc = docOf([agent('a', 0, 0), agent('b', 10, 10), agent('c', 20, 20), agent('keep', 700, 0), agent('keep2', 1400, 0)])
    const after = tidy(doc, { scope: { kind: 'selection', ids: ['a', 'b', 'c'] } })
    expect(rectOf(after, 'keep')).toMatchObject({ x: 700, y: 0 })
    expect(rectOf(after, 'keep2')).toMatchObject({ x: 1400, y: 0 })
    expectNoOverlap(after, null)
  })

  test('inside a group, selected members stay in it and clear of the others', () => {
    const doc = docOf([
      group('g', 0, 0, 1400, 1000),
      agent('stay', GROUP_PAD, GROUP_TOP, { parentId: 'g' }),
      agent('a', GROUP_PAD + 20, GROUP_TOP + 20, { parentId: 'g' }),
      agent('b', GROUP_PAD + 40, GROUP_TOP + 40, { parentId: 'g' })
    ])
    const after = tidy(doc, { scope: { kind: 'selection', ids: ['a', 'b'] } })
    expect(after.nodes.filter((n) => ['a', 'b'].includes(n.id)).every((n) => n.parentId === 'g')).toBe(true)
    expect(after.nodes.find((n) => n.id === 'stay')).toMatchObject({ x: GROUP_PAD, y: GROUP_TOP })
    expectNoOverlap(after, 'g')
    for (const id of ['stay', 'a', 'b']) expect(inside(rectOf(after, id), rectOf(after, 'g'))).toBe(true)
  })

  test('a selection across groups tidies the top-level blocks they are in', () => {
    const doc = docOf([group('g', 0, 0, 700, 600), agent('m', GROUP_PAD, GROUP_TOP, { parentId: 'g' }), agent('free', 100, 100)])
    const plan = planTidy(doc, opts({ scope: { kind: 'selection', ids: ['m', 'free'] } }))!
    expect(plan.parentId).toBeNull()
    expect(plan.units).toEqual(['g', 'free'])
    expectNoOverlap(reduce(doc, tidyOp(plan)), null)
  })
})

describe('stable', () => {
  const cases: [string, Partial<TidyOptions>, () => CanvasDoc][] = [
    ['project', {}, messy],
    ['project, needs you first', { byStatus: true, statuses: { lead: 'idle', w2: 'needs-you', solo: 'working' } }, messy],
    ['group', { scope: { kind: 'group', id: 'g' } }, messy],
    ['selection', { scope: { kind: 'selection', ids: ['w1', 'w2', 'note'] } }, messy]
  ]
  test.each(cases)('tidying twice changes nothing the second time (%s)', (_name, over, make) => {
    const once = tidy(make(), over)
    expect(planTidy(once, opts(over))!.moves).toEqual([])
    expect(tidy(once, over)).toBe(once)
  })

  test('a new node goes at the end and nothing else moves', () => {
    const once = tidy(messy())
    const more = { ...once, nodes: [...once.nodes, node('new', { x: 40, y: 40, ...NOTE })] }
    expect(planTidy(more, opts())!.moves.map((m) => m.id)).toEqual(['new'])
  })

  test('dragging one node away and tidying moves only that node back', () => {
    const once = tidy(messy())
    const dragged = reduce(once, { op: 'patchNode', id: 'solo', patch: { x: -3000, y: 4000 } })
    const plan = planTidy(dragged, opts())!
    expect(plan.moves).toEqual([{ id: 'solo', x: rectOf(once, 'solo').x, y: rectOf(once, 'solo').y }])
  })

  test('a new member of a cluster moves only its own cluster and what follows it', () => {
    const once = tidy(messy())
    const more = { ...once, nodes: [...once.nodes, agent('w4', 0, 3000, { openedBy: 'lead' })] }
    const moved = planTidy(more, opts())!.moves.map((m) => m.id)
    expect(moved).toContain('w4')
    expect(moved).not.toContain('lead')
  })
})

describe('applying', () => {
  test('the whole tidy is one undo step that puts every node and the group size back', () => {
    const before = docOf([
      group('g', 0, 0, 900, 900),
      agent('a', GROUP_PAD, GROUP_TOP, { parentId: 'g' }),
      agent('b', GROUP_PAD + 9, GROUP_TOP + 9, { parentId: 'g' }),
      agent('c', 100, 2000)
    ])
    const plan = planTidy(before, opts({ scope: { kind: 'group', id: 'g' } }))!
    const entry = entryFor(before, 'tidy', [tidyOp(plan)])!
    expect(entry.label).toBe('tidy')
    const after = reduce(before, tidyOp(plan))
    const undone = reduce(after, { op: 'restoreLayout', ...entry.undo })
    for (const n of before.nodes) {
      const u = undone.nodes.find((x) => x.id === n.id)!
      expect([u.x, u.y, u.width, u.height, u.parentId], n.id).toEqual([n.x, n.y, n.width, n.height, n.parentId])
    }
    const redone = reduce(undone, { op: 'restoreLayout', ...entry.redo })
    for (const n of after.nodes) expect(redone.nodes.find((x) => x.id === n.id)).toMatchObject({ x: n.x, y: n.y, width: n.width, height: n.height })
  })

  test('nothing to undo when it was already tidy', () => {
    const once = tidy(messy())
    expect(entryFor(once, 'tidy', [tidyOp(planTidy(once, opts())!)])).toBeNull()
  })

  test('moveNodes fits the group round its moved members and ignores bad positions', () => {
    const doc = docOf([group('g', 0, 0, 2000, 2000), agent('a', GROUP_PAD, GROUP_TOP, { parentId: 'g' })])
    const after = reduce(doc, { op: 'moveNodes', moves: [{ id: 'a', x: GROUP_PAD, y: GROUP_TOP + 1 }, { id: 'zz', x: 1, y: 1 }] })
    expect(after.nodes.find((n) => n.id === 'g')).toMatchObject({ width: 2 * GROUP_PAD + AGENT.width, height: GROUP_TOP + 1 + AGENT.height + GROUP_PAD })
    expect(reduce(doc, { op: 'moveNodes', moves: [{ id: 'a', x: Number.NaN, y: 0 }] })).toBe(doc)
  })

  test('tidyResult gives where each unit and the group will be drawn', () => {
    const doc = messy()
    const plan = planTidy(doc, opts({ scope: { kind: 'group', id: 'g' } }))!
    const after = reduce(doc, tidyOp(plan))
    expect(tidyResult(doc, plan)).toEqual(['g', 'g1', 'g2'].map((id) => ({ id, rect: rectOf(after, id) })))
  })
})

describe('fits the view', () => {
  test('the result is about as wide as the view is shaped, not one long row', () => {
    const many = Array.from({ length: 12 }, (_, i) => agent(`n${i}`, i * 20, 0))
    const after = tidy(docOf(many))
    const b = boundsOf(many.map((n) => rectOf(after, n.id)))!
    expect(b.width / b.height).toBeGreaterThan(0.8)
    expect(b.width / b.height).toBeLessThan(3)
  })

  test('the view pans only as far as it must', () => {
    const view = { x: 0, y: 0, width: 1000, height: 800 }
    expect(panToShow(view, { x: 100, y: 100, width: 300, height: 300 })).toEqual({ x: 0, y: 0 })
    expect(panToShow(view, { x: 900, y: -100, width: 300, height: 300 })).toEqual({ x: 200, y: -100 })
    // Bigger than the view, and the view is already over it: no pan.
    expect(panToShow(view, { x: -500, y: -500, width: 3000, height: 3000 })).toEqual({ x: 0, y: 0 })
    // Bigger than the view, and off to one side: pan until the view is over it.
    expect(panToShow(view, { x: 400, y: 0, width: 3000, height: 800 })).toEqual({ x: 400, y: 0 })
  })
})

test('nothing to tidy gives no plan', () => {
  expect(planTidy(docOf([]), opts())).toBeNull()
  expect(planTidy(messy(), opts({ scope: { kind: 'group', id: 'w1' } }))).toBeNull()
  expect(planTidy(messy(), opts({ scope: { kind: 'selection', ids: ['nope'] } }))).toBeNull()
})
