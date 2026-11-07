import { describe, expect, test } from 'vitest'
import type { CanvasDoc, CanvasNode, ClaudeNode, GroupNode, StickyNode, TerminalNode } from '../../src/shared/model'
import { cablePath, dropParent, mergeFlowNodes, toFlow } from '../../src/renderer/flowMapping'

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const group: GroupNode = { ...box, id: 'g', kind: 'group', title: 'G', worktree: null }
const term: TerminalNode = { ...box, id: 't', kind: 'terminal', title: 'T', cwd: 'C:\\x', parentId: 'g' }
const claude: ClaudeNode = {
  ...box,
  id: 'c',
  kind: 'claude',
  title: 'C',
  cwd: 'C:\\x',
  sessionId: null,
  transcriptPath: null,
  after: []
}
const sticky: StickyNode = { ...box, id: 's', kind: 'sticky', title: 'S', text: 'hi' }

function doc(nodes: CanvasNode[], edges: CanvasDoc['edges'] = []): CanvasDoc {
  return { version: 3, projects: [], activeProjectId: '', nodes, edges, closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
}

describe('toFlow', () => {
  test('keeps parents before children and maps status into node data', () => {
    const { nodes } = toFlow(doc([group, term, claude, sticky]), { c: 'working', t: 'exited' })
    expect(nodes.map((n) => n.id)).toEqual(['g', 't', 'c', 's'])
    expect(nodes[1].parentId).toBe('g')
    expect(nodes[1].type).toBe('terminal')
    expect(nodes[1].data.status).toBe('exited')
    expect(nodes[2].data.status).toBe('working')
    expect(nodes[2].data.node).toBe(claude)
    expect(nodes[0].parentId).toBeUndefined()
  })

  test('a Claude node with no reported status is unknown, never a guess', () => {
    const { nodes } = toFlow(doc([claude]), {})
    expect(nodes[0].data.status).toBe('unknown')
  })

  test('a terminal or sticky with no reported status has none', () => {
    const { nodes } = toFlow(doc([{ ...term, parentId: null }, sticky]), {})
    expect(nodes.map((n) => n.data.status)).toEqual([null, null])
  })

  test('edge kinds map to distinct classes: opened, link, after', () => {
    const { edges } = toFlow(
      doc(
        [{ ...term, parentId: null }, claude],
        [
          { id: 'a', from: 't', to: 'c', kind: 'opened' },
          { id: 'b', from: 't', to: 'c', kind: 'link' },
          { id: 'd', from: 't', to: 'c', kind: 'after' }
        ]
      ),
      {}
    )
    expect(edges.map((e) => [e.source, e.target])).toEqual([
      ['t', 'c'],
      ['t', 'c'],
      ['t', 'c']
    ])
    const classes = edges.map((e) => e.className)
    expect(new Set(classes).size).toBe(3)
    expect(classes).toEqual(['cable-opened', 'cable-link', 'cable-after'])
  })
})

describe('mergeFlowNodes', () => {
  const next = (d: CanvasDoc, s = {}): ReturnType<typeof toFlow>['nodes'] => toFlow(d, s).nodes

  test('an unchanged node keeps its object, so it does not re-render', () => {
    const first = next(doc([claude, sticky]))
    const merged = mergeFlowNodes(first, next(doc([claude, sticky])))
    expect(merged[0]).toBe(first[0])
    expect(merged[1]).toBe(first[1])
  })

  test('a node being dragged keeps its local position when a doc arrives', () => {
    const [local] = next(doc([sticky]))
    const dragging = { ...local, dragging: true, position: { x: 500, y: 600 } }
    const moved = { ...sticky, x: 9, y: 9, title: 'renamed' }
    const [merged] = mergeFlowNodes([dragging], next(doc([moved])))
    expect(merged.position).toEqual({ x: 500, y: 600 })
    expect(merged.data.node.title).toBe('renamed')
  })

  test('a changed node takes the doc position and keeps its selection', () => {
    const [local] = next(doc([sticky]))
    const moved = { ...sticky, x: 9, y: 9 }
    const [merged] = mergeFlowNodes([{ ...local, selected: true }], next(doc([moved])))
    expect(merged.position).toEqual({ x: 9, y: 9 })
    expect(merged.selected).toBe(true)
  })

  test('a status change alone updates the node', () => {
    const first = next(doc([claude]), { c: 'working' })
    const [merged] = mergeFlowNodes(first, next(doc([claude]), { c: 'needs-you' }))
    expect(merged.data.status).toBe('needs-you')
  })

  test('removed nodes go away', () => {
    const first = next(doc([claude, sticky]))
    expect(mergeFlowNodes(first, next(doc([sticky]))).map((n) => n.id)).toEqual(['s'])
  })
})

describe('dropParent', () => {
  const groups = [
    { id: 'outer', x: 0, y: 0, width: 1000, height: 1000 },
    { id: 'inner', x: 100, y: 100, width: 300, height: 300 }
  ]

  test('picks the smallest group holding the center of the node', () => {
    expect(dropParent({ x: 150, y: 150, width: 50, height: 50 }, groups)).toBe('inner')
    expect(dropParent({ x: 600, y: 600, width: 50, height: 50 }, groups)).toBe('outer')
  })

  test('outside every group gives null', () => {
    expect(dropParent({ x: 5000, y: 0, width: 50, height: 50 }, groups)).toBeNull()
  })
})

describe('cablePath', () => {
  test('hangs below both ends, like a real patch cable', () => {
    const { path, sagY } = cablePath(0, 100, 400, 100)
    expect(path.startsWith('M 0 100')).toBe(true)
    expect(path.endsWith('400 100')).toBe(true)
    expect(sagY).toBeGreaterThan(100)
  })

  test('a longer cable sags more', () => {
    expect(cablePath(0, 0, 900, 0).sagY).toBeGreaterThan(cablePath(0, 0, 200, 0).sagY)
  })
})
