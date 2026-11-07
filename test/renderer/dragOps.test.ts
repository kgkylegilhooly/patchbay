import { describe, expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { dragOps } from '../../src/renderer/dragOps'
import { absolutePosition, groupMembers, newGroup } from '../../src/renderer/newNodes'
import type { CanvasDoc, CanvasNode, GroupNode, StickyNode } from '../../src/shared/model'

const group: GroupNode = { id: 'g', kind: 'group', title: 'G', x: 100, y: 100, width: 600, height: 400, parentId: null, worktree: null }
const sticky: StickyNode = { id: 's', kind: 'sticky', title: 'S', text: '', x: 900, y: 100, width: 100, height: 100, parentId: null }
const inside: StickyNode = { ...sticky, id: 'i', x: 200, y: 200, parentId: 'g' }

function doc(nodes: CanvasNode[]): CanvasDoc {
  return { version: 3, projects: [], activeProjectId: '', nodes, edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
}

function run(d: CanvasDoc, moved: Parameters<typeof dragOps>[1]): CanvasDoc {
  return dragOps(d, moved).reduce(reduce, d)
}

describe('dragOps', () => {
  test('a move with no change of parent is one position patch', () => {
    const ops = dragOps(doc([sticky]), [{ id: 's', abs: { x: 950, y: 150 }, rel: { x: 950, y: 150 } }])
    expect(ops).toEqual([{ op: 'patchNode', id: 's', patch: { x: 950, y: 150 } }])
  })

  test('dropping into a group adopts the node where it was dropped', () => {
    const after = run(doc([group, sticky]), [{ id: 's', abs: { x: 300, y: 300 }, rel: { x: 300, y: 300 } }])
    const s = after.nodes.find((n) => n.id === 's')!
    expect(s.parentId).toBe('g')
    expect(absolutePosition(after, s)).toEqual({ x: 300, y: 300 })
  })

  test('dropped position holds even if the group has to shift to fit', () => {
    // The sticky's old spot is left of the group, so adopting it moves the group's origin first.
    const left = { ...sticky, x: 10, y: 10 }
    const after = run(doc([group, left]), [{ id: 's', abs: { x: 300, y: 300 }, rel: { x: 300, y: 300 } }])
    const s = after.nodes.find((n) => n.id === 's')!
    expect(s.parentId).toBe('g')
    expect(absolutePosition(after, s)).toEqual({ x: 300, y: 300 })
  })

  test('dragging out of a group releases the node at the same spot', () => {
    const after = run(doc([group, inside]), [{ id: 'i', abs: { x: 2000, y: 2000 }, rel: { x: 1900, y: 1900 } }])
    const i = after.nodes.find((n) => n.id === 'i')!
    expect(i.parentId).toBeNull()
    expect({ x: i.x, y: i.y }).toEqual({ x: 2000, y: 2000 })
  })

  test('a group never gets adopted, and a child dragged with its group just moves', () => {
    const ops = dragOps(doc([group, inside]), [
      { id: 'g', abs: { x: 150, y: 150 }, rel: { x: 150, y: 150 } },
      { id: 'i', abs: { x: 350, y: 350 }, rel: { x: 200, y: 200 } }
    ])
    expect(ops.every((op) => op.op === 'patchNode')).toBe(true)
  })
})

describe('new groups', () => {
  test('frame the selected nodes with room for the header', () => {
    const g = newGroup(doc([sticky]), { x: 0, y: 0 }, 'n', [sticky])
    expect(g.x).toBeLessThan(sticky.x)
    expect(g.y).toBeLessThanOrEqual(sticky.y - 40)
    expect(g.x + g.width).toBeGreaterThan(sticky.x + sticky.width)
    expect(g.y + g.height).toBeGreaterThan(sticky.y + sticky.height)
  })

  test('with nothing selected, an empty group opens at the given spot', () => {
    const g = newGroup(doc([]), { x: 7, y: 9 }, 'n', [])
    expect([g.x, g.y]).toEqual([7, 9])
  })

  test('a child whose group is also selected moves with the group', () => {
    const members = groupMembers(doc([group, inside, sticky]), ['g', 'i', 's'])
    expect(members.map((m) => m.id)).toEqual(['g', 's'])
  })
})
