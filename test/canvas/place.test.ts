import { describe, expect, test } from 'vitest'
import { absoluteRect, GROUP_PAD, GROUP_TOP, PLACE_GAP, placeInGroup, placeInProject, placeNear, viewRect, type Rect } from '../../src/core/canvas/place'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

const AGENT = { width: 620, height: 420 }
const STICKY = { width: 280, height: 220 }

function node(id: string, box: Partial<CanvasNode> & { x: number; y: number }, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, kind: 'sticky', title: id, text: '', parentId: null, projectId: 'p1', ...AGENT, ...box, ...extra } as CanvasNode
}

function docOf(nodes: CanvasNode[], over: Partial<CanvasDoc> = {}): CanvasDoc {
  return {
    version: 3,
    projects: [
      { id: 'p1', name: 'One', folder: '', viewport: { x: 0, y: 0, zoom: 1 } },
      { id: 'p2', name: 'Two', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }
    ],
    activeProjectId: 'p1',
    nodes,
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...over
  }
}

const tops = (doc: CanvasDoc, projectId = 'p1'): Rect[] => doc.nodes.filter((n) => !n.parentId && (n.projectId ?? doc.activeProjectId) === projectId)
const covers = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const gapBetween = (a: Rect, b: Rect): number =>
  Math.hypot(Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)), Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)))

/**
 * The person's report: the lead at the top left, and right beside it a tall group of four agents in a 2x2 grid. The
 * old placement put a new note to the lead's right, found the group there, and slid down below the whole group.
 */
function reportedCanvas(): CanvasDoc {
  const groupW = 2 * GROUP_PAD + 2 * AGENT.width + PLACE_GAP
  const groupH = GROUP_TOP + 2 * AGENT.height + PLACE_GAP + GROUP_PAD
  return docOf([
    node('lead', { x: 0, y: 0 }, { kind: 'claude' } as Partial<CanvasNode>),
    node('team', { x: 660, y: 0, width: groupW, height: groupH }, { kind: 'group', worktree: null } as Partial<CanvasNode>),
    node('a', { x: GROUP_PAD, y: GROUP_TOP, parentId: 'team' }),
    node('b', { x: GROUP_PAD + AGENT.width + PLACE_GAP, y: GROUP_TOP, parentId: 'team' }),
    node('c', { x: GROUP_PAD, y: GROUP_TOP + AGENT.height + PLACE_GAP, parentId: 'team' }),
    node('d', { x: GROUP_PAD + AGENT.width + PLACE_GAP, y: GROUP_TOP + AGENT.height + PLACE_GAP, parentId: 'team' })
  ])
}

describe('placeNear', () => {
  test('on an empty canvas a new node goes right beside its opener, level with it', () => {
    const doc = docOf([node('lead', { x: 100, y: 50 })])
    expect(placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p1' })).toEqual({ x: 100 + 620 + PLACE_GAP, y: 50 })
  })

  test("the report's canvas: a note from the lead lands next to the lead, not below the tall group", () => {
    const doc = reportedCanvas()
    const lead = absoluteRect(doc, doc.nodes[0])
    const team = doc.nodes[1]
    const spot = placeNear(doc, { beside: lead, size: STICKY, projectId: 'p1' })
    const placed = { ...spot, ...STICKY }
    // Touching the lead, at the gap.
    expect(gapBetween(placed, lead)).toBe(PLACE_GAP)
    // Nowhere near the bottom of the group, where it used to go.
    expect(placed.y).toBeLessThan(team.y + team.height)
    expect(placed.y).toBeLessThanOrEqual(lead.y + lead.height + PLACE_GAP)
    for (const box of tops(doc)) expect(covers(placed, box)).toBe(false)
    // Right is taken by the group, so it's directly below the lead, under its left edge.
    expect(spot).toEqual({ x: 0, y: 420 + PLACE_GAP })
  })

  test("the report's canvas: further notes keep close to the lead, each clear of the rest", () => {
    let doc = reportedCanvas()
    const lead = absoluteRect(doc, doc.nodes[0])
    for (let i = 0; i < 4; i++) {
      const spot = placeNear(doc, { beside: lead, size: STICKY, projectId: 'p1' })
      const placed = { ...spot, ...STICKY }
      for (const box of tops(doc)) expect(covers(placed, box)).toBe(false)
      expect(gapBetween(placed, lead)).toBeLessThan(STICKY.height + 2 * PLACE_GAP + 1)
      doc = { ...doc, nodes: [...doc.nodes, node(`n${i}`, spot, STICKY)] }
    }
  })

  test('the side order is right, below, left, above', () => {
    const anchor = { x: 0, y: 0, ...AGENT }
    const blocker = (id: string, x: number, y: number) => node(id, { x, y })
    const right = { x: 620 + PLACE_GAP, y: 0 }
    const below = { x: 0, y: 420 + PLACE_GAP }
    const left = { x: -280 - PLACE_GAP, y: 0 }
    const above = { x: 0, y: -220 - PLACE_GAP }
    let doc = docOf([node('lead', { x: 0, y: 0 })])
    const next = () => placeNear(doc, { beside: anchor, size: STICKY, projectId: 'p1' })
    expect(next()).toEqual(right)
    doc = { ...doc, nodes: [...doc.nodes, blocker('r', right.x, right.y)] }
    expect(next()).toEqual(below)
    doc = { ...doc, nodes: [...doc.nodes, blocker('b', below.x, below.y)] }
    expect(next()).toEqual(left)
    doc = { ...doc, nodes: [...doc.nodes, node('l', { x: left.x - 340, y: left.y })] }
    expect(next()).toEqual(above)
  })

  test('a crowded canvas: the spot found is free and the nearest of the free ones around', () => {
    // A ring of agents around the lead, with one gap to the lower right.
    const nodes = [node('lead', { x: 0, y: 0 })]
    const ring = [-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => [i, j] as const)).filter(([i, j]) => !(i === 0 && j === 0) && !(i === 1 && j === 1))
    for (const [i, j] of ring) nodes.push(node(`r${i}${j}`, { x: i * (620 + PLACE_GAP), y: j * (420 + PLACE_GAP) }))
    const doc = docOf(nodes)
    const spot = placeNear(doc, { beside: absoluteRect(doc, nodes[0]), size: STICKY, projectId: 'p1' })
    const placed = { ...spot, ...STICKY }
    for (const box of tops(doc)) expect(covers(placed, box)).toBe(false)
    expect(spot).toEqual({ x: 620 + PLACE_GAP, y: 420 + PLACE_GAP })
  })

  test("another project's nodes don't push a node away, and its own project's do", () => {
    const doc = docOf([node('lead', { x: 0, y: 0 }), node('elsewhere', { x: 660, y: 0, width: 2000, height: 2000 }, { projectId: 'p2' })])
    expect(placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p1' })).toEqual({ x: 660, y: 0 })
    const there = placeNear(doc, { at: { x: 700, y: 100 }, size: STICKY, projectId: 'p2' })
    expect(covers({ ...there, ...STICKY }, doc.nodes[1])).toBe(false)
  })

  test("a node with no project belongs to the one on screen", () => {
    const doc = docOf([node('lead', { x: 0, y: 0 }), node('loose', { x: 660, y: 0 }, { projectId: undefined })])
    const spot = placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p1' })
    expect(spot).not.toEqual({ x: 660, y: 0 })
  })

  test('with the view known, a spot on screen wins over a nearer one off it', () => {
    // The lead sits at the left edge of the view, so its left side is off screen; right and below are taken.
    const doc = docOf([node('lead', { x: 0, y: 0 }), node('r', { x: 660, y: 0 }), node('b', { x: 0, y: 460 })])
    const view = { x: -20, y: -300, width: 1600, height: 1200 }
    const spot = placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p1', view })
    const placed = { ...spot, ...STICKY }
    expect(placed.x >= view.x && placed.y >= view.y && placed.x + placed.width <= view.x + view.width && placed.y + placed.height <= view.y + view.height).toBe(true)
    // Without the view it's the nearer spot on the left.
    expect(placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p1' })).toEqual({ x: -320, y: 0 })
  })

  test('a node opened from inside a group lands outside the group, next to it', () => {
    const doc = reportedCanvas()
    const member = doc.nodes.find((n) => n.id === 'b')!
    const team = doc.nodes[1]
    const spot = placeNear(doc, { beside: absoluteRect(doc, member), size: STICKY, projectId: 'p1' })
    const placed = { ...spot, ...STICKY }
    for (const box of tops(doc)) expect(covers(placed, box)).toBe(false)
    // Just past the group's right edge, level with the member.
    expect(spot).toEqual({ x: team.x + team.width + PLACE_GAP, y: absoluteRect(doc, member).y })
  })

  test('a spot asked for is kept when free and nudged clear when not', () => {
    const doc = docOf([node('a', { x: 0, y: 0 })])
    expect(placeNear(doc, { at: { x: 900, y: 900 }, size: STICKY, projectId: 'p1' })).toEqual({ x: 900, y: 900 })
    const nudged = placeNear(doc, { at: { x: 100, y: 100 }, size: STICKY, projectId: 'p1' })
    expect(covers({ ...nudged, ...STICKY }, doc.nodes[0])).toBe(false)
    expect(Math.hypot(nudged.x - 100, nudged.y - 100)).toBeLessThan(500)
  })
})

describe('placeInGroup', () => {
  const group = (kids: Array<{ x: number; y: number } & Partial<CanvasNode>>, width = 668, height = 508): CanvasDoc =>
    docOf([node('g', { x: 0, y: 0, width, height }, { kind: 'group', worktree: null } as Partial<CanvasNode>), ...kids.map((k, i) => node(`k${i}`, { ...k, parentId: 'g' }))])

  test('fills rows left to right, two members wide, then wraps', () => {
    let doc = group([])
    const spots: Array<{ x: number; y: number }> = []
    for (let i = 0; i < 5; i++) {
      const spot = placeInGroup(doc, 'g', AGENT)
      spots.push(spot)
      doc = { ...doc, nodes: [...doc.nodes, node(`m${i}`, { ...spot, parentId: 'g' })] }
    }
    const col = (i: number) => GROUP_PAD + i * (AGENT.width + PLACE_GAP)
    const row = (j: number) => GROUP_TOP + j * (AGENT.height + PLACE_GAP)
    expect(spots).toEqual([
      { x: col(0), y: row(0) },
      { x: col(1), y: row(0) },
      { x: col(0), y: row(1) },
      { x: col(1), y: row(1) },
      { x: col(0), y: row(2) }
    ])
  })

  test('a group already wider than two members, as a team row is, fills its width before wrapping', () => {
    const col = (i: number) => GROUP_PAD + i * (AGENT.width + PLACE_GAP)
    const doc = group([{ x: col(0), y: GROUP_TOP }, { x: col(1), y: GROUP_TOP }, { x: col(2), y: GROUP_TOP }], 2 * GROUP_PAD + 3 * AGENT.width + 2 * PLACE_GAP)
    expect(placeInGroup(doc, 'g', AGENT)).toEqual({ x: col(0), y: GROUP_TOP + AGENT.height + PLACE_GAP })
    expect(placeInGroup(doc, 'g', STICKY)).toEqual({ x: col(0), y: GROUP_TOP + AGENT.height + PLACE_GAP })
  })

  test('a small member fills a hole in a row before a new row starts', () => {
    const doc = group([{ x: GROUP_PAD, y: GROUP_TOP }])
    expect(placeInGroup(doc, 'g', STICKY)).toEqual({ x: GROUP_PAD + AGENT.width + PLACE_GAP, y: GROUP_TOP })
  })

  test('an empty or missing group starts at its first cell', () => {
    expect(placeInGroup(group([]), 'g', AGENT)).toEqual({ x: GROUP_PAD, y: GROUP_TOP })
    expect(placeInGroup(docOf([]), 'nope', AGENT)).toEqual({ x: GROUP_PAD, y: GROUP_TOP })
  })

  test('never overlaps a member, however they were moved around', () => {
    const doc = group([{ x: 300, y: 100 }, { x: 24, y: 700, width: 280, height: 220 }, { x: 900, y: 64 }], 1600, 1000)
    const spot = placeInGroup(doc, 'g', AGENT)
    const kids = doc.nodes.filter((n) => n.parentId === 'g')
    for (const k of kids) expect(covers({ ...spot, ...AGENT }, k)).toBe(false)
  })
})

describe('placeInProject and viewRect', () => {
  test('the view is the window less the sidebar and dock edges, in canvas coordinates', () => {
    const doc = docOf([], { viewport: { x: -1000, y: -500, zoom: 2 } })
    expect(viewRect(doc, 'p1', { width: 1248, height: 908 })).toEqual({ x: 512, y: 262, width: 600, height: 400 })
    expect(viewRect(doc, 'p1', null)).toBeNull()
  })

  test("another project's view is the one it was left at", () => {
    const doc = docOf([], { projects: [{ id: 'p1', name: 'One', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }, { id: 'p2', name: 'Two', folder: '', viewport: { x: -3000, y: 0, zoom: 1 } }] })
    expect(viewRect(doc, 'p2', { width: 1000, height: 800 })!.x).toBe(3024)
  })

  test('with nothing to sit beside, a node goes in the middle of the view, clear of what is there', () => {
    const doc = docOf([node('mid', { x: 300, y: 200 })])
    const spot = placeInProject(doc, 'p1', STICKY, { width: 1648, height: 1108 })
    const view = viewRect(doc, 'p1', { width: 1648, height: 1108 })!
    const placed = { ...spot, ...STICKY }
    expect(covers(placed, doc.nodes[0])).toBe(false)
    expect(placed.x >= view.x && placed.y >= view.y && placed.x + placed.width <= view.x + view.width && placed.y + placed.height <= view.y + view.height).toBe(true)
  })

  test("without the window's size, it goes near the view's top left", () => {
    const doc = docOf([], { viewport: { x: -400, y: -200, zoom: 1 } })
    expect(placeInProject(doc, 'p1', STICKY)).toEqual({ x: 480, y: 280 })
  })
})

describe('placeInGroup next to other nodes (review H1)', () => {
  const GROUP = { width: 668, height: 508 }
  const groupAt = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}) =>
    node(id, { x, y, ...GROUP }, { kind: 'group', worktree: null, ...extra } as Partial<CanvasNode>)
  const member = (id: string, parentId: string) => node(id, { x: GROUP_PAD, y: GROUP_TOP, parentId })
  /** The group's box once the reducer has fitted it to a new member here. */
  const grown = (g: CanvasNode, spot: { x: number; y: number }, size: { width: number; height: number }): Rect => ({
    x: g.x,
    y: g.y,
    width: Math.max(g.width, spot.x + size.width + GROUP_PAD),
    height: Math.max(g.height, spot.y + size.height + GROUP_PAD)
  })
  const TERMINAL = { width: 560, height: 340 }

  test("compare's two attempt groups: a terminal opened into the left one goes below, so the group doesn't grow over the right one", () => {
    const doc = docOf([groupAt('a', 0, 0), member('ma', 'a'), groupAt('b', GROUP.width + PLACE_GAP, 0), member('mb', 'b')])
    const spot = placeInGroup(doc, 'a', TERMINAL)
    expect(spot).toEqual({ x: GROUP_PAD, y: GROUP_TOP + 420 + PLACE_GAP })
    expect(covers(grown(doc.nodes[0], spot, TERMINAL), doc.nodes[2])).toBe(false)
  })

  test('with a node directly below the group, it grows to the right instead', () => {
    const doc = docOf([groupAt('g', 0, 0), member('m', 'g'), node('below', { x: 0, y: GROUP.height + PLACE_GAP })])
    const spot = placeInGroup(doc, 'g', TERMINAL)
    expect(spot).toEqual({ x: GROUP_PAD + 620 + PLACE_GAP, y: GROUP_TOP })
    expect(covers(grown(doc.nodes[0], spot, TERMINAL), doc.nodes[2])).toBe(false)
  })

  test('boxed in on the right and below, it still goes in the grid, as the only place left', () => {
    const doc = docOf([groupAt('g', 0, 0), member('m', 'g'), node('r', { x: GROUP.width + PLACE_GAP, y: 0, width: 3000, height: 3000 }), node('b', { x: 0, y: GROUP.height + PLACE_GAP, width: 600 })])
    expect(placeInGroup(doc, 'g', TERMINAL)).toEqual({ x: GROUP_PAD + 620 + PLACE_GAP, y: GROUP_TOP })
  })

  test("another project's node beside the group doesn't count", () => {
    const doc = docOf([groupAt('g', 0, 0), member('m', 'g'), node('other', { x: GROUP.width + PLACE_GAP, y: 0 }, { projectId: 'p2' })])
    expect(placeInGroup(doc, 'g', TERMINAL)).toEqual({ x: GROUP_PAD + 620 + PLACE_GAP, y: GROUP_TOP })
  })

  test('a group inside a group keeps clear of its own siblings', () => {
    const doc = docOf([
      node('outer', { x: 0, y: 0, width: 2000, height: 1200 }, { kind: 'group', worktree: null } as Partial<CanvasNode>),
      groupAt('inner', GROUP_PAD, GROUP_TOP, { parentId: 'outer' }),
      member('m', 'inner'),
      node('sib', { x: GROUP_PAD + GROUP.width + PLACE_GAP, y: GROUP_TOP, parentId: 'outer' })
    ])
    expect(placeInGroup(doc, 'inner', TERMINAL)).toEqual({ x: GROUP_PAD, y: GROUP_TOP + 420 + PLACE_GAP })
  })
})

describe('the visible area the page reports (review M1)', () => {
  test('a reported area is used as it is, so an open sidebar is left out', () => {
    const doc = docOf([], { viewport: { x: 0, y: 0, zoom: 0.5 } })
    // A 1400x900 canvas with the sidebar open: the page reports x 330 onward.
    expect(viewRect(doc, 'p1', { x: 330, y: 24, width: 1046, height: 792 })).toEqual({ x: 660, y: 48, width: 2092, height: 1584 })
  })

  test('next to a lead at the left edge, a spot under the sidebar loses to one in the visible area', () => {
    // The lead starts where the sidebar ends. Right and below are taken; left would be under the sidebar.
    const doc = docOf([node('lead', { x: 330, y: 24 }), node('r', { x: 990, y: 24 }), node('b', { x: 330, y: 484 })])
    const view = viewRect(doc, 'p1', { x: 330, y: 24, width: 1600, height: 1000 })!
    const spot = placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p1', view })
    expect(spot.x).toBeGreaterThanOrEqual(330)
  })
})

test('a node saved before projects existed is in the way in every project (review L4)', () => {
  const doc = docOf([node('lead', { x: 0, y: 0 }, { projectId: 'p2' }), node('legacy', { x: 660, y: 0 }, { projectId: undefined })])
  const spot = placeNear(doc, { beside: absoluteRect(doc, doc.nodes[0]), size: STICKY, projectId: 'p2' })
  expect(covers({ ...spot, ...STICKY }, doc.nodes[1])).toBe(false)
})
