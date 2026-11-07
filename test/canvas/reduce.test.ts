import { describe, expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import type {
  CanvasDoc,
  CanvasNode,
  ClaudeNode,
  ClosedSession,
  Edge,
  GroupNode,
  StickyNode,
  TerminalNode
} from '../../src/shared/model'

function emptyDoc(over: Partial<CanvasDoc> = {}): CanvasDoc {
  return { version: 3, projects: [], activeProjectId: '', nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 }, ...over }
}
const base = { title: 't', width: 100, height: 100, parentId: null as string | null }
function group(id: string, x: number, y: number, over: Partial<GroupNode> = {}): GroupNode {
  return { ...base, id, x, y, width: 500, height: 500, kind: 'group', worktree: null, ...over }
}
function term(id: string, x: number, y: number, over: Partial<TerminalNode> = {}): TerminalNode {
  return { ...base, id, x, y, kind: 'terminal', cwd: 'C:/w', ...over }
}
function sticky(id: string, x: number, y: number, over: Partial<StickyNode> = {}): StickyNode {
  return { ...base, id, x, y, kind: 'sticky', text: '', ...over }
}
function claude(id: string, over: Partial<ClaudeNode> = {}): ClaudeNode {
  return { ...base, id, x: 0, y: 0, kind: 'claude', cwd: 'C:/w', sessionId: null, transcriptPath: null, after: [], ...over }
}
function edge(id: string, from: string, to: string, kind: Edge['kind'] = 'link'): Edge {
  return { id, from, to, kind }
}
function find(doc: CanvasDoc, id: string): CanvasNode {
  const n = doc.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}
function parentsFirst(doc: CanvasDoc): boolean {
  const seen = new Set<string>()
  for (const n of doc.nodes) {
    if (n.parentId && !seen.has(n.parentId)) return false
    seen.add(n.id)
  }
  return true
}

describe('setParent', () => {
  test('setParent keeps a node at the same absolute position', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), term('n', 150, 160)] })
    const inGroup = reduce(doc, { op: 'setParent', ids: ['n'], parentId: 'g' })
    const child = find(inGroup, 'n')
    expect(child.parentId).toBe('g')
    expect(child.x).toBe(50)
    expect(child.y).toBe(60)

    const free = find(reduce(inGroup, { op: 'setParent', ids: ['n'], parentId: null }), 'n')
    expect(free.parentId).toBeNull()
    expect(free.x).toBe(150)
    expect(free.y).toBe(160)
  })

  test('setParent keeps absolute position through nested groups', () => {
    const doc = emptyDoc({
      nodes: [group('outer', 100, 100), group('inner', 30, 50, { parentId: 'outer' }), term('n', 300, 300)]
    })
    const next = reduce(doc, { op: 'setParent', ids: ['n'], parentId: 'inner' })
    const n = find(next, 'n')
    const inner = find(next, 'inner')
    const outer = find(next, 'outer')
    expect(outer.x + inner.x + n.x).toBe(300)
    expect(outer.y + inner.y + n.y).toBe(300)
  })

  test('setParent refuses a cycle: the doc is returned unchanged', () => {
    const doc = emptyDoc({
      nodes: [group('a', 0, 0), group('b', 10, 10, { parentId: 'a' }), group('c', 10, 10, { parentId: 'b' })]
    })
    expect(reduce(doc, { op: 'setParent', ids: ['a'], parentId: 'c' })).toBe(doc)
    expect(reduce(doc, { op: 'setParent', ids: ['a'], parentId: 'a' })).toBe(doc)
  })

  test('setParent refuses a parent that is missing or not a group', () => {
    const doc = emptyDoc({ nodes: [term('t', 0, 0), sticky('s', 10, 10)] })
    expect(reduce(doc, { op: 'setParent', ids: ['s'], parentId: 'nope' })).toBe(doc)
    expect(reduce(doc, { op: 'setParent', ids: ['s'], parentId: 't' })).toBe(doc)
  })
})

describe('removeNodes', () => {
  test('removing a group promotes children and keeps their absolute position', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), term('n', 50, 60, { parentId: 'g' })] })
    const next = reduce(doc, { op: 'removeNodes', ids: ['g'], at: 1 })
    expect(next.nodes.map((n) => n.id)).toEqual(['n'])
    const n = find(next, 'n')
    expect(n.parentId).toBeNull()
    expect(n.x).toBe(150)
    expect(n.y).toBe(160)
  })

  test('removing a nested group promotes children to the outer group', () => {
    const doc = emptyDoc({
      nodes: [group('outer', 100, 100), group('inner', 10, 20, { parentId: 'outer' }), term('n', 5, 5, { parentId: 'inner' })]
    })
    const next = reduce(doc, { op: 'removeNodes', ids: ['inner'], at: 1 })
    const n = find(next, 'n')
    const outer = find(next, 'outer')
    expect(n.parentId).toBe('outer')
    expect(outer.x + n.x).toBe(115)
    expect(outer.y + n.y).toBe(125)
  })

  test('removing a group and its child together removes both', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), term('n', 5, 5, { parentId: 'g' })] })
    expect(reduce(doc, { op: 'removeNodes', ids: ['g', 'n'], at: 1 }).nodes).toEqual([])
  })

  test('removeNodes also removes edges touching those nodes', () => {
    const doc = emptyDoc({
      nodes: [term('a', 0, 0), term('b', 0, 0), term('c', 0, 0)],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'a', 'c')]
    })
    const next = reduce(doc, { op: 'removeNodes', ids: ['b'], at: 1 })
    expect(next.edges.map((e) => e.id)).toEqual(['e3'])
  })

  test('removing a node clears it from the after list of another node', () => {
    const doc = emptyDoc({ nodes: [claude('a'), claude('b', { after: ['a', 'x'] })] })
    const next = reduce(doc, { op: 'removeNodes', ids: ['a'], at: 1 })
    expect((find(next, 'b') as ClaudeNode).after).toEqual(['x'])
  })

  test('removing a node clears openedBy on the nodes it opened', () => {
    const doc = emptyDoc({ nodes: [claude('a'), term('b', 0, 0, { openedBy: 'a' })] })
    expect(find(reduce(doc, { op: 'removeNodes', ids: ['a'], at: 1 }), 'b').openedBy).toBeNull()
  })

  test('removing a Claude node with a sessionId adds a ClosedSession with closedAt = op.at', () => {
    const doc = emptyDoc({
      nodes: [claude('c', { title: 'Agent', cwd: 'C:/repo', sessionId: 's1', transcriptPath: 'C:/t.jsonl' })]
    })
    const next = reduce(doc, { op: 'removeNodes', ids: ['c'], at: 1234 })
    expect(next.closed).toHaveLength(1)
    expect(next.closed[0]).toMatchObject({
      title: 'Agent',
      cwd: 'C:/repo',
      sessionId: 's1',
      transcriptPath: 'C:/t.jsonl',
      closedAt: 1234
    })
    expect(next.closed[0].id.length).toBeGreaterThan(0)
  })

  test('closing the same conversation twice gives history entries with different ids', () => {
    const a = reduce(emptyDoc({ nodes: [claude('c', { sessionId: 's1' })] }), { op: 'removeNodes', ids: ['c'], at: 5 })
    const b = reduce({ ...a, nodes: [claude('c', { sessionId: 's1' })] }, { op: 'removeNodes', ids: ['c'], at: 5 })
    const ids = b.closed.map((c) => c.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  test('removing a Claude node with no sessionId, or a terminal, adds no history', () => {
    const doc = emptyDoc({ nodes: [claude('c'), term('t', 0, 0)] })
    const next = reduce(doc, { op: 'removeNodes', ids: ['c', 't'], at: 1 })
    expect(next.closed).toEqual([])
    expect(next.nodes).toEqual([])
  })

  test('closed history keeps the newest 200', () => {
    const closed: ClosedSession[] = Array.from({ length: 200 }, (_, i) => ({
      id: `old${i}`,
      title: 'x',
      cwd: 'C:/',
      sessionId: `s${i}`,
      transcriptPath: null,
      closedAt: i
    }))
    const doc = emptyDoc({ closed, nodes: [claude('c', { sessionId: 'newest' })] })
    const next = reduce(doc, { op: 'removeNodes', ids: ['c'], at: 9999 })
    expect(next.closed).toHaveLength(200)
    expect(next.closed.some((c) => c.sessionId === 'newest')).toBe(true)
    expect(next.closed.some((c) => c.closedAt === 0)).toBe(false)
    expect(next.closed.some((c) => c.closedAt === 1)).toBe(true)
  })
})

describe('ordering', () => {
  test('nodes are ordered with parents before children after any op', () => {
    let doc = emptyDoc({ nodes: [term('n', 0, 0, { parentId: 'g' }), group('g', 0, 0)] })
    doc = reduce(doc, { op: 'setViewport', viewport: { x: 1, y: 1, zoom: 2 } })
    expect(parentsFirst(doc)).toBe(true)

    doc = reduce(emptyDoc({ nodes: [term('n', 0, 0)] }), { op: 'addNode', node: group('g2', 0, 0) })
    doc = reduce(doc, { op: 'setParent', ids: ['n'], parentId: 'g2' })
    expect(parentsFirst(doc)).toBe(true)

    doc = reduce(doc, { op: 'addNode', node: term('m', 0, 0, { parentId: 'g2' }) })
    expect(parentsFirst(doc)).toBe(true)

    doc = reduce(doc, { op: 'addNode', node: group('g3', 0, 0) })
    doc = reduce(doc, { op: 'setParent', ids: ['g2'], parentId: 'g3' })
    expect(parentsFirst(doc)).toBe(true)
  })

  test('addNode with a missing parent, or one that is not a group, keeps the node at the top level', () => {
    const doc = reduce(emptyDoc({ nodes: [term('t', 0, 0)] }), { op: 'addNode', node: term('n', 7, 8, { parentId: 'ghost' }) })
    expect(find(doc, 'n').x).toBe(7)
    expect(find(doc, 'n').parentId).toBeNull()
    const next = reduce(doc, { op: 'addNode', node: term('m', 1, 2, { parentId: 't' }) })
    expect(find(next, 'm').parentId).toBeNull()
  })

  test('parent data with a cycle in a loaded doc does not hang and keeps every node', () => {
    const doc = emptyDoc({ nodes: [group('a', 0, 0, { parentId: 'b' }), group('b', 0, 0, { parentId: 'a' })] })
    const next = reduce(doc, { op: 'setViewport', viewport: { x: 1, y: 1, zoom: 1 } })
    expect(next.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  })
})

describe('group fitting', () => {
  test('a group fits its right and bottom edges to its children with 24 px padding', () => {
    const doc = emptyDoc({ nodes: [group('g', 0, 0), sticky('s', 200, 300, { width: 100, height: 50 })] })
    const next = reduce(doc, { op: 'setParent', ids: ['s'], parentId: 'g' })
    const g = find(next, 'g')
    const s = find(next, 's')
    expect(s.x).toBe(200)
    expect(s.y).toBe(300)
    expect(g.width).toBe(324)
    expect(g.height).toBe(374)
  })

  test('a child left of or above the group moves the group, clearing the header', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), sticky('s', 50, 50, { width: 50, height: 50 })] })
    const next = reduce(doc, { op: 'setParent', ids: ['s'], parentId: 'g' })
    const g = find(next, 'g')
    const s = find(next, 's')
    expect(s.x).toBe(24)
    expect(s.y).toBe(64)
    expect(g.x + s.x).toBe(50)
    expect(g.y + s.y).toBe(50)
    expect(g.width).toBe(98)
    expect(g.height).toBe(138)
  })

  test('a child under the header moves the group', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), sticky('s', 150, 130, { width: 50, height: 50 })] })
    const next = reduce(doc, { op: 'setParent', ids: ['s'], parentId: 'g' })
    expect(find(next, 's').y).toBe(64)
    expect(find(next, 'g').y).toBe(66)
  })

  test('moving a child keeps every sibling at the same absolute position', () => {
    let doc = emptyDoc({
      nodes: [
        group('g', 100, 100),
        sticky('a', 150, 200, { width: 50, height: 50 }),
        sticky('b', 300, 300, { width: 50, height: 50 })
      ]
    })
    doc = reduce(doc, { op: 'setParent', ids: ['a', 'b'], parentId: 'g' })
    doc = reduce(doc, { op: 'patchNode', id: 'a', patch: { x: -16 } })
    const g = find(doc, 'g')
    expect(g.x + find(doc, 'b').x).toBe(300)
    expect(g.y + find(doc, 'b').y).toBe(300)
    expect(g.x + find(doc, 'a').x).toBe(84)
    expect(find(doc, 'a').x).toBe(24)
  })

  test('resizing a child refits the group', () => {
    let doc = emptyDoc({ nodes: [group('g', 0, 0), sticky('a', 100, 100, { width: 50, height: 50 })] })
    doc = reduce(doc, { op: 'setParent', ids: ['a'], parentId: 'g' })
    doc = reduce(doc, { op: 'patchNode', id: 'a', patch: { width: 200 } })
    expect(find(doc, 'g').width).toBe(324)
  })

  test('renaming a child leaves a resized group alone', () => {
    let doc = emptyDoc({ nodes: [group('g', 0, 0), sticky('a', 100, 100, { width: 50, height: 50 })] })
    doc = reduce(doc, { op: 'setParent', ids: ['a'], parentId: 'g' })
    doc = reduce(doc, { op: 'patchNode', id: 'g', patch: { width: 900 } })
    doc = reduce(doc, { op: 'patchNode', id: 'a', patch: { title: 'renamed' } })
    expect(find(doc, 'g').width).toBe(900)
  })

  test('adding a child to a group fits the group', () => {
    const doc = emptyDoc({ nodes: [group('g', 0, 0)] })
    const next = reduce(doc, { op: 'addNode', node: sticky('a', 30, 70, { parentId: 'g', width: 50, height: 50 }) })
    expect(find(next, 'g').width).toBe(104)
    expect(find(next, 'g').height).toBe(144)
  })

  test('removing a child refits the group to the children left', () => {
    const doc = emptyDoc({
      nodes: [
        group('g', 0, 0),
        sticky('a', 30, 70, { parentId: 'g', width: 50, height: 50 }),
        sticky('b', 400, 400, { parentId: 'g', width: 50, height: 50 })
      ]
    })
    const next = reduce(doc, { op: 'removeNodes', ids: ['b'], at: 1 })
    expect(find(next, 'g').width).toBe(104)
  })

  test('moving a group does not change the relative positions of its children', () => {
    let doc = emptyDoc({ nodes: [group('g', 0, 0), sticky('a', 100, 100, { width: 50, height: 50 })] })
    doc = reduce(doc, { op: 'setParent', ids: ['a'], parentId: 'g' })
    const before = find(doc, 'a')
    doc = reduce(doc, { op: 'patchNode', id: 'g', patch: { x: 500, y: 600 } })
    expect(find(doc, 'g').x).toBe(500)
    expect(find(doc, 'a')).toEqual(before)
  })

  test('an empty group keeps its size', () => {
    const doc = emptyDoc({ nodes: [group('g', 0, 0), sticky('a', 100, 100, { parentId: 'g' })] })
    const next = reduce(doc, { op: 'setParent', ids: ['a'], parentId: null })
    expect(find(next, 'g').width).toBe(500)
    expect(find(next, 'g').height).toBe(500)
  })

  test('a nested group fit reaches the outer group', () => {
    let doc = emptyDoc({
      nodes: [
        group('outer', 0, 0),
        group('inner', 50, 50, { parentId: 'outer', width: 100, height: 100 }),
        sticky('a', 500, 500, { width: 50, height: 50 })
      ]
    })
    doc = reduce(doc, { op: 'setParent', ids: ['a'], parentId: 'inner' })
    const outer = find(doc, 'outer')
    const inner = find(doc, 'inner')
    const a = find(doc, 'a')
    expect(outer.x + inner.x + a.x).toBe(500)
    expect(outer.y + inner.y + a.y).toBe(500)
    expect(inner.width).toBe(524)
    expect(outer.width).toBe(598)
  })
})

describe('other ops', () => {
  test('patchNode cannot change the id or kind of a node', () => {
    const doc = emptyDoc({ nodes: [term('a', 0, 0)] })
    const next = reduce(doc, { op: 'patchNode', id: 'a', patch: { id: 'z', kind: 'group', title: 'new' } as Partial<CanvasNode> })
    const n = find(next, 'a')
    expect(n.kind).toBe('terminal')
    expect(n.title).toBe('new')
  })

  test('patchNode cannot reparent: setParent is the only way', () => {
    const doc = emptyDoc({ nodes: [group('g', 0, 0), term('a', 10, 10)] })
    const next = reduce(doc, { op: 'patchNode', id: 'a', patch: { parentId: 'g' } })
    expect(find(next, 'a').parentId).toBeNull()
  })

  test('patchNode on a missing id returns the doc unchanged', () => {
    const doc = emptyDoc()
    expect(reduce(doc, { op: 'patchNode', id: 'nope', patch: { title: 'x' } })).toBe(doc)
  })

  test('addNode with an existing id returns the doc unchanged', () => {
    const doc = emptyDoc({ nodes: [term('a', 0, 0)] })
    expect(reduce(doc, { op: 'addNode', node: term('a', 9, 9) })).toBe(doc)
  })

  test('addEdge refuses a duplicate id or a missing endpoint', () => {
    const doc = emptyDoc({ nodes: [term('a', 0, 0), term('b', 0, 0)], edges: [edge('e', 'a', 'b')] })
    expect(reduce(doc, { op: 'addEdge', edge: edge('e', 'b', 'a') })).toBe(doc)
    expect(reduce(doc, { op: 'addEdge', edge: edge('e2', 'a', 'ghost') })).toBe(doc)
  })

  test('addEdge refuses a second edge with the same ends and kind', () => {
    const doc = emptyDoc({ nodes: [term('a', 0, 0), term('b', 0, 0)], edges: [edge('e', 'a', 'b', 'link')] })
    expect(reduce(doc, { op: 'addEdge', edge: edge('e2', 'a', 'b', 'link') })).toBe(doc)
    expect(reduce(doc, { op: 'addEdge', edge: edge('e3', 'a', 'b', 'opened') }).edges).toHaveLength(2)
  })

  test('addEdge and removeEdge add and remove', () => {
    const doc = emptyDoc({ nodes: [term('a', 0, 0), term('b', 0, 0)] })
    const added = reduce(doc, { op: 'addEdge', edge: edge('e', 'a', 'b') })
    expect(added.edges).toHaveLength(1)
    expect(reduce(added, { op: 'removeEdge', id: 'e' }).edges).toEqual([])
  })

  test('reduce does not mutate the input doc', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), term('n', 150, 160)] })
    const snapshot = JSON.parse(JSON.stringify(doc))
    reduce(doc, { op: 'setParent', ids: ['n'], parentId: 'g' })
    reduce(doc, { op: 'removeNodes', ids: ['g'], at: 1 })
    reduce(doc, { op: 'arrange', ids: ['n', 'g'], layout: 'row' })
    expect(doc).toEqual(snapshot)
  })

  test('the arrange op moves the named nodes', () => {
    const doc = emptyDoc({ nodes: [term('a', 0, 0), term('b', 0, 0), term('c', 999, 999)] })
    const next = reduce(doc, { op: 'arrange', ids: ['a', 'b'], layout: 'row', gap: 10 })
    expect(find(next, 'b').x - find(next, 'a').x).toBe(110)
    expect(find(next, 'c').x).toBe(999)
  })

  test('arrange treats nodes in different groups by absolute position', () => {
    const doc = emptyDoc({
      nodes: [group('g', 100, 100), sticky('a', 50, 70, { parentId: 'g' }), sticky('b', 500, 500)]
    })
    const next = reduce(doc, { op: 'arrange', ids: ['a', 'b'], layout: 'row', gap: 10 })
    const g = find(next, 'g')
    const a = find(next, 'a')
    const b = find(next, 'b')
    expect(g.x + a.x).toBe(150)
    expect(g.y + a.y).toBe(170)
    expect(b.x).toBe(260)
    expect(b.y).toBe(170)
  })

  test('arranging a group and its child moves only the group', () => {
    const doc = emptyDoc({ nodes: [group('g', 100, 100), sticky('a', 50, 70, { parentId: 'g' }), sticky('b', 900, 900)] })
    const next = reduce(doc, { op: 'arrange', ids: ['g', 'a', 'b'], layout: 'row', gap: 10 })
    expect(find(next, 'a').x).toBe(50)
    expect(find(next, 'a').y).toBe(70)
    expect(find(next, 'b').x).toBe(100 + find(next, 'g').width + 10)
  })
})

describe('removeClosed', () => {
  const entry = (id: string): ClosedSession => ({ id, title: 't', cwd: 'C:/w', sessionId: 's', transcriptPath: null, closedAt: 1 })

  test('removes only that entry', () => {
    const doc = emptyDoc({ closed: [entry('a'), entry('b')] })
    expect(reduce(doc, { op: 'removeClosed', id: 'a' }).closed.map((c) => c.id)).toEqual(['b'])
  })

  test('an unknown entry returns the same doc', () => {
    const doc = emptyDoc({ closed: [entry('a')] })
    expect(reduce(doc, { op: 'removeClosed', id: 'nope' })).toBe(doc)
  })
})
